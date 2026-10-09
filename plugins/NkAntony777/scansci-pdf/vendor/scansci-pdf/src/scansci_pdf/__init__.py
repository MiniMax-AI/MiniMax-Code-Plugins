"""Source-only ScanSci PDF fork with no import-time environment mutation."""

__version__ = "1.18.0.post1"

__all__ = ["__version__", "download", "batch_download", "search_papers", "load_config", "update_config", "get_config_safe"]


def __getattr__(name):
    if name in {"download", "batch_download"}:
        from . import sources
        return getattr(sources, name)
    if name == "search_papers":
        from .search import search_papers
        return search_papers
    if name in {"load_config", "update_config", "get_config_safe"}:
        from . import config
        return getattr(config, name)
    raise AttributeError(name)
