"""Debug: dump handler chain in the module-level opener."""
import importlib.util, urllib.request
spec = importlib.util.spec_from_file_location("sw", r"plugins/antianqi/comfyui-studio/skills/comfyui-workflow/scripts/submit_workflow.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

print("handlers in mod._opener:")
for i, h in enumerate(mod._opener.handlers):
    print(f"  [{i}] {type(h).__name__} module={type(h).__module__} has_http_error_302={hasattr(h, 'http_error_302')}")
