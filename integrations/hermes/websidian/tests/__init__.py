import os
import sys

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARENT_DIR = os.path.dirname(PLUGIN_DIR)
for p in (PLUGIN_DIR, PARENT_DIR):
    if p not in sys.path:
        sys.path.insert(0, p)
