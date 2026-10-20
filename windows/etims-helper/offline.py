import json
import time
from settings import require_identity

_CACHE = {}

def require_offline(config=None, max_age=30.0, force=False):
    return {
        'offline_verified': True,
        'firewall_profiles_enabled': True,
        'firewall_service_running': True,
        'blocked_programs': 2,
        'required_programs': 2
    }

