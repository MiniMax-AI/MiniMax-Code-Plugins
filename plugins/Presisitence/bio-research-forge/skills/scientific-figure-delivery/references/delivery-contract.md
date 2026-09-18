# Figure delivery contract

Deliver a coherent set:

- `figure.<svg|pdf>`: editable or vector master;
- `figure.tiff`: journal raster when requested, at the required physical size and resolution;
- `figure-preview.png`: conversation preview;
- generation code in the selected backend;
- source-data table or a documented pointer to it;
- short README or metadata block with conclusion, n, statistics, parameters, software versions, and hashes.

The PNG preview is required even when the journal file is PDF/TIFF. The preview and publication export must come from the same final rendering state.

For multi-panel figures, assign one message per panel and one synthesis message for the whole figure. Remove redundant legends and table-like gridlines. Aesthetics may clarify evidence but must not change its meaning.
