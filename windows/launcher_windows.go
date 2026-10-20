//go:build windows

package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var buildID = "development"
var user32 = syscall.NewLazyDLL("user32.dll")
var kernel32 = syscall.NewLazyDLL("kernel32.dll")
var client = &http.Client{Timeout: time.Second, Transport: &http.Transport{Proxy: nil}}

const baseURL = "http://127.0.0.1:3000"

type config struct {
	Browser  string `json:"browser"`
	Instance string `json:"instance"`
}
type health struct {
	App      string `json:"app"`
	Instance string `json:"instance"`
	Build    string `json:"build"`
}

func message(text string, flags uintptr) uintptr {
	body, _ := syscall.UTF16PtrFromString(text)
	title, _ := syscall.UTF16PtrFromString("Oraforge POS")
	result, _, _ := user32.NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(title)), flags)
	return result
}
func exists(path string) bool { info, err := os.Stat(path); return err == nil && !info.IsDir() }
func appPath(exe string) string {
	for _, root := range []syscall.Handle{syscall.HKEY_CURRENT_USER, syscall.HKEY_LOCAL_MACHINE} {
		for _, view := range []uint32{0x0100, 0x0200} {
			keyName, _ := syscall.UTF16PtrFromString(`Software\Microsoft\Windows\CurrentVersion\App Paths\` + exe)
			var key syscall.Handle
			if syscall.RegOpenKeyEx(root, keyName, 0, syscall.KEY_READ|view, &key) != nil {
				continue
			}
			var kind, size uint32
			err := syscall.RegQueryValueEx(key, nil, nil, &kind, nil, &size)
			if err == nil && size > 0 && size < 65536 && kind == syscall.REG_SZ {
				buf := make([]uint16, size/2+1)
				err = syscall.RegQueryValueEx(key, nil, nil, &kind, (*byte)(unsafe.Pointer(&buf[0])), &size)
				syscall.RegCloseKey(key)
				result := strings.Trim(syscall.UTF16ToString(buf), `"`)
				if err == nil && exists(result) {
					return result
				}
			} else {
				syscall.RegCloseKey(key)
			}
		}
	}
	return ""
}
func browserPath(kind string) string {
	exe, sub := "msedge.exe", filepath.Join("Microsoft", "Edge", "Application", "msedge.exe")
	if kind == "chrome" {
		exe, sub = "chrome.exe", filepath.Join("Google", "Chrome", "Application", "chrome.exe")
	}
	if result := appPath(exe); result != "" {
		return result
	}
	for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"} {
		if root := os.Getenv(env); root != "" {
			if result := filepath.Join(root, sub); exists(result) {
				return result
			}
		}
	}
	return ""
}
func lock(dataDir string) (func(), error) {
	sum := sha256.Sum256([]byte(strings.ToLower(dataDir)))
	name, _ := syscall.UTF16PtrFromString(`Local\OraforgePOS-` + hex.EncodeToString(sum[:8]))
	handle, _, err := kernel32.NewProc("CreateMutexW").Call(0, 0, uintptr(unsafe.Pointer(name)))
	if handle == 0 {
		return nil, err
	}
	result, _, _ := kernel32.NewProc("WaitForSingleObject").Call(handle, 30000)
	if result != 0 && result != 0x80 {
		kernel32.NewProc("CloseHandle").Call(handle)
		return nil, errors.New("Another POS launch is still starting. Please try again shortly.")
	}
	return func() { kernel32.NewProc("ReleaseMutex").Call(handle); kernel32.NewProc("CloseHandle").Call(handle) }, nil
}
func serverHealth() (health, error) {
	var h health
	resp, err := client.Get(baseURL + "/api/local/health")
	if err != nil {
		return h, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return h, errors.New("unexpected server response")
	}
	err = json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&h)
	return h, err
}
func seedFile(from, to string) error {
	if exists(to) {
		return nil
	}
	data, err := os.ReadFile(from)
	if err != nil {
		return err
	}
	return os.WriteFile(to, data, 0600)
}
func run() error {
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		return errors.New("Windows local application data folder is unavailable.")
	}
	dataDir := filepath.Join(local, "OraforgePOS")
	if err := os.MkdirAll(filepath.Join(dataDir, "backups"), 0700); err != nil {
		return err
	}
	unlock, err := lock(dataDir)
	if err != nil {
		return err
	}
	defer unlock()
	cfgPath := filepath.Join(dataDir, "launcher.json")
	var cfg config
	data, err := os.ReadFile(cfgPath)
	if err == nil {
		if json.Unmarshal(data, &cfg) != nil || len(cfg.Instance) != 32 || (cfg.Browser != "edge" && cfg.Browser != "chrome") {
			return fmt.Errorf("Cannot read saved POS browser settings: %s. Keep this folder and contact support.", cfgPath)
		}
	} else if os.IsNotExist(err) {
		cfg.Browser = "edge"
		if browserPath(cfg.Browser) == "" {
			cfg.Browser = "chrome"
		}
		if browserPath(cfg.Browser) == "" {
			return errors.New("Install Microsoft Edge or Google Chrome, then open Oraforge POS again.")
		}
		token := make([]byte, 16)
		if _, err = rand.Read(token); err != nil {
			return err
		}
		cfg.Instance = hex.EncodeToString(token)
		data, _ = json.MarshalIndent(cfg, "", "  ")
		if err = os.WriteFile(cfgPath, data, 0600); err != nil {
			return err
		}
	} else {
		return err
	}
	if len(os.Args) > 1 && os.Args[1] == "--stop" {
		h, err := serverHealth()
		if err != nil || h.App != "oraforge-pos" || h.Instance != cfg.Instance {
			message("The packaged POS server is not running.", 0x40)
			return nil
		}
		if message("Close the POS browser windows first. Stop the local POS server now?", 0x124) != 6 {
			return nil
		}
		req, _ := http.NewRequest("POST", baseURL+"/api/local/stop", nil)
		req.Header.Set("X-POS-Instance", cfg.Instance)
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return errors.New("The POS server could not be stopped.")
		}
		return nil
	}
	browser := browserPath(cfg.Browser)
	if browser == "" {
		return fmt.Errorf("Your POS uses %s, which is no longer installed. Reinstall it to keep using the same saved shop data. The launcher will not switch browsers automatically.", cfg.Browser)
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	folder := filepath.Dir(exe)
	node := filepath.Join(folder, "runtime", "node.exe")
	app := filepath.Join(folder, "app", "capacitor")
	for _, file := range []string{node, filepath.Join(app, "dev-server.js"), filepath.Join(app, "www", "sqlite-bridge.js")} {
		if !exists(file) {
			return errors.New("POS files are missing. Extract the entire ZIP into a folder before opening OraforgePOS.exe. Keep runtime and app beside the EXE.")
		}
	}
	if err = seedFile(filepath.Join(folder, "app", "swifta.txt"), filepath.Join(dataDir, "swifta.txt")); err != nil {
		return err
	}
	if err = seedFile(filepath.Join(app, "sozuri-config.json"), filepath.Join(dataDir, "sozuri-config.json")); err != nil {
		return err
	}
	_ = seedFile(filepath.Join(folder, "pos.sqlite3"), filepath.Join(dataDir, "pos.sqlite3"))
	h, healthErr := serverHealth()
	if healthErr == nil && h.App == "oraforge-pos" && h.Instance == cfg.Instance {
		if h.Build != buildID {
			return errors.New("A different POS version is running. Close its browser windows, run Stop POS.cmd, then reopen this EXE.")
		}
	} else {
		conn, err := net.DialTimeout("tcp", "127.0.0.1:3000", time.Second)
		if err == nil {
			conn.Close()
			return errors.New("Port 3000 is occupied by another program or another POS version. Close that program and try again. The POS keeps the same address to protect access to your saved shop.")
		}
		logPath := filepath.Join(dataDir, "server.log")
		if info, err := os.Stat(logPath); err == nil && info.Size() > 1024*1024 {
			_ = os.Remove(logPath + ".old")
			_ = os.Rename(logPath, logPath+".old")
		}
		logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		defer logFile.Close()
		cmd := exec.Command(node, filepath.Join(app, "dev-server.js"))
		cmd.Dir = app
		cmd.Env = append(os.Environ(), "POS_DESKTOP=1", "PORT=3000", "POS_PORT=3000", "POS_INSTANCE="+cfg.Instance, "POS_BUILD="+buildID, "POS_DATA_DIR="+dataDir, "POS_BACKUP_DIR="+filepath.Join(dataDir, "backups"), "SWIFTA_ATTEMPTS_PATH="+filepath.Join(dataDir, "swifta-attempts.json"), "POS_ROOT_DIR="+folder)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
		cmd.Stdout, cmd.Stderr = logFile, logFile
		if err = cmd.Start(); err != nil {
			return err
		}
		ready := false
		for i := 0; i < 80; i++ {
			h, err = serverHealth()
			if err == nil && h.App == "oraforge-pos" && h.Instance == cfg.Instance && h.Build == buildID {
				ready = true
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
		if !ready {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			return fmt.Errorf("POS could not start. Startup details are in %s", logPath)
		}
		_ = cmd.Process.Release()
	}
	// CI smoke tests can start and verify the real Windows server without opening a GUI.
	if len(os.Args) > 1 && os.Args[1] == "--headless" {
		return nil
	}
	cmd := exec.Command(browser, "--user-data-dir="+filepath.Join(dataDir, "browser-"+cfg.Browser), "--no-first-run", "--no-default-browser-check", "--app=http://localhost:3000/pos")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err = cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
func main() {
	if err := run(); err != nil {
		message(err.Error(), 0x10)
		os.Exit(1)
	}
}
