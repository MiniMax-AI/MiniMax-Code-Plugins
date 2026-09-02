# enrich_circos.R —— 富集分析圈图（circlize 多轨道：分类/背景基因/前景基因(上下调)/RichFactor）
# 输入: enrich(GO_enrich.csv 或 KEGG_enrich.csv), 需列: pvalue,RichFactor,Bg_gene,Count[,Up,Down]
# params: enrich, outdir, type("go"|"kegg"), topN(每类10), split_count(有Up/Down时按上下调拆分),
#         show_axis(T), ifLog(F), circ1/2/3.color, dpi(300), width(8),height(8), name
# 说明: 图例需 ComplexHeatmap（缺失则跳过图例，圈图主体仍由 circlize 正常绘制）。
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("dplyr", "circlize"))
has_ch <- requireNamespace("ComplexHeatmap", quietly = TRUE)

type <- rgraph_opt(p, "type", "go")
group_col <- if (type == "kegg") "Category" else "ONTOLOGY"
id_col <- if (type == "kegg") "KEGGID" else "GOID"
topN <- rgraph_opt(p, "topN", 10)
show_axis <- rgraph_opt(p, "show_axis", TRUE)
ifLog <- rgraph_opt(p, "ifLog", FALSE)
c1 <- rgraph_opt(p, "circ1_color", c("#f7cb16", "#65c3fc", "#bfe046"))
c2 <- rgraph_opt(p, "circ2_color", c("#fee5d9", "#fb6a4a"))
c3 <- rgraph_opt(p, "circ3_color", c("#68a6e3", "#99CCFF"))

df <- read.csv(p$enrich, stringsAsFactors = FALSE, check.names = FALSE)
for (col in c(group_col, id_col, "pvalue", "RichFactor", "Bg_gene", "Count"))
  if (!col %in% names(df)) stop(paste0("富集表缺少列: ", col))
split_count <- rgraph_opt(p, "split_count", all(c("Up", "Down") %in% names(df)))
df$.grp <- df[[group_col]]; df$.id <- df[[id_col]]
df$neg_log10_pvalue <- -log10(df$pvalue)

dt <- df %>% dplyr::group_by(.grp) %>% dplyr::slice_min(pvalue, n = topN, with_ties = FALSE) %>%
  dplyr::arrange(dplyr::desc(RichFactor), .by_group = TRUE) %>% dplyr::ungroup()
main.col <- c1[as.numeric(as.factor(dt$.grp))]
p_max <- ceiling(max(dt$neg_log10_pvalue))
color_assign <- circlize::colorRamp2(0:p_max, grDevices::colorRampPalette(c2)(p_max + 1))
bgmax <- max(dt$Bg_gene, na.rm = TRUE)

df1 <- data.frame(id = dt$.id, start = 0, end = bgmax)
df2 <- data.frame(id = dt$.id, start = 0, end = if (show_axis) dt$Bg_gene else bgmax,
                  Bg_gene = dt$Bg_gene, col = color_assign(dt$neg_log10_pvalue))
if (split_count) {
  tempLong <- if (ifLog) log10(bgmax + 1) else bgmax
  frac <- dt$Up / pmax(dt$Up + dt$Down, 1)
  df3 <- rbind(
    data.frame(id = dt$.id, start = 0, end = frac * tempLong, count = dt$Up, col = c3[1]),
    data.frame(id = dt$.id, start = frac * tempLong, end = tempLong, count = dt$Down, col = c3[2]))
  df3$count <- ifelse(df3$count == 0, "", df3$count)
} else {
  df3 <- data.frame(id = dt$.id, start = 0, end = if (show_axis) dt$Count else bgmax,
                    count = dt$Count, col = c3[1])
}
df4 <- data.frame(id = dt$.id, start = 0, end = bgmax, ratio = dt$RichFactor, col = main.col)
if (ifLog) { df1$end <- log10(df1$end + 1); df2$end <- log10(df2$end + 1)
  if (!split_count) df3$end <- log10(df3$end + 1); df4$end <- log10(df4$end + 1) }

draw_fn <- function() {
  par(omi = c(0.1, 0.1, 0.1, 1.5))
  circlize::circos.par(track.margin = c(0.01, 0.01))
  circlize::circos.genomicInitialize(df1, plotType = "none")
  circlize::circos.trackPlotRegion(ylim = c(0, 1), track.height = 0.08, bg.border = NA, bg.col = main.col,
    panel.fun = function(x, y) {
      circlize::circos.text(mean(circlize::get.cell.meta.data("xlim")), 0.5,
        circlize::get.cell.meta.data("sector.index"), cex = rgraph_opt(p, "circ1_size", 0.45),
        facing = "bending.inside", niceFacing = TRUE) })
  if (show_axis) for (si in circlize::get.all.sector.index())
    circlize::circos.axis(h = "top", labels.cex = rgraph_opt(p, "axis_size", 0.3), sector.index = si,
      track.index = 1, major.at = pretty(c(0, max(df1$end, na.rm = TRUE)), n = 5), labels.facing = "clockwise")
  circlize::circos.genomicTrack(df2, ylim = c(0, 1), track.height = 0.1, bg.border = "white",
    panel.fun = function(region, value, ...) {
      circlize::circos.genomicRect(region, value, ytop = 0, ybottom = 1, col = value[, 2], border = NA, ...)
      circlize::circos.genomicText(region, value, y = 0.5, labels = value[, 1], adj = c(0.5, 0.5),
        cex = rgraph_opt(p, "circ2_size", 0.5), ...) })
  circlize::circos.genomicTrack(df3, ylim = c(0, 1), track.height = 0.1, bg.border = "white",
    panel.fun = function(region, value, ...) {
      circlize::circos.genomicRect(region, value, ytop = 0, ybottom = 1, col = value[, 2], border = NA, ...)
      circlize::circos.genomicText(region, value, y = 0.5, labels = value[, 1], adj = c(0.5, 0.5),
        cex = rgraph_opt(p, "circ3_size", 0.3), ...) })
  circlize::circos.genomicTrack(df4, ylim = c(0, max(dt$RichFactor, na.rm = TRUE)), track.height = 0.35,
    bg.border = "white", bg.col = "grey97",
    panel.fun = function(region, value, ...)
      circlize::circos.genomicRect(region, value, ytop = 0, ybottom = value[, 1], col = value[, 2], border = NA, ...))
  circlize::circos.clear()
  if (has_ch) {
    ml <- ComplexHeatmap::Legend(labels = unique(dt$.grp), type = "points", pch = 15,
      legend_gp = grid::gpar(col = c1), title = group_col, size = grid::unit(3, "mm"))
    lp <- ComplexHeatmap::Legend(col_fun = circlize::colorRamp2(round(seq(0, p_max, length.out = 6), 0),
      grDevices::colorRampPalette(c2)(6)), title = "-log10(pvalue)")
    ComplexHeatmap::draw(ComplexHeatmap::packLegend(ml, lp),
      x = grid::unit(1, "snpc") * 0.85, y = grid::unit(1, "snpc") * 0.5, just = "left")
  }
}

rgraph_save_base(p$outdir, rgraph_opt(p, "name", paste0(toupper(type), "_loop")), draw_fn,
                 width = rgraph_opt(p, "width", 8), height = rgraph_opt(p, "height", 8),
                 dpi = rgraph_opt(p, "dpi", 300))
cat("RGRAPH_DONE: enrich_circos", type, "terms=", nrow(dt), "legend=", has_ch, "\n")
