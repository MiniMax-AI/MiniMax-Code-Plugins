# heatmap.R —— 差异基因/指定基因表达聚类热图
# 引擎: pheatmap(默认) 或 complexheatmap(按分组加顶部色块标签、列不聚类)
# params: fpkm, sample_group, outdir, deg(可选 Deg_all.csv 路径), genes(可选基因向量),
#         engine("pheatmap"|"complexheatmap"), scale("row"|"column"|"none"),
#         cluster_rows(T), cluster_cols(T), show_rownames(默认自动),
#         low/mid/high 颜色, dpi(300), width,height, name
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("dplyr"))

fpkm <- rgraph_read_matrix(p$fpkm)
sg <- rgraph_read_sample_group(p$sample_group)
rgraph_check_samples(fpkm, sg$sample_name)

# 选基因
if (!is.null(p$genes)) {
  genes <- p$genes
} else if (!is.null(p$deg)) {
  deg <- read.csv(p$deg, check.names = FALSE)
  genes <- deg$gene_id
} else {
  genes <- fpkm$gene_id
}
sub <- fpkm[fpkm$gene_id %in% genes, c("gene_id", sg$sample_name)]
rownames(sub) <- sub$gene_id; sub$gene_id <- NULL
sub <- as.matrix(sub); sub[is.na(sub)] <- 0
sub <- log2(sub + 1)
sub <- sub[rowSums(sub) != 0, , drop = FALSE]
sub <- sub[, colSums(sub) != 0, drop = FALSE]
if (nrow(sub) < 2) stop("可用于热图的基因不足 2 个")

scale_by <- rgraph_opt(p, "scale", "row")
show_rn <- rgraph_opt(p, "show_rownames", nrow(sub) <= 50)
low  <- rgraph_opt(p, "low", "blue"); mid <- rgraph_opt(p, "mid", "white"); high <- rgraph_opt(p, "high", "red")
nm <- rgraph_opt(p, "name", "heatmap")
w <- rgraph_opt(p, "width", 8); h <- rgraph_opt(p, "height", 8); dpi <- rgraph_opt(p, "dpi", 300)
engine <- rgraph_opt(p, "engine", "pheatmap")

if (engine == "complexheatmap") {
  rgraph_library(c("ComplexHeatmap", "circlize"))
  sc <- t(scale(t(sub)))
  col_fun <- circlize::colorRamp2(c(min(sc), 0, max(sc)), c(low, mid, high))
  grp <- factor(sg$group_name[match(colnames(sub), sg$sample_name)],
                levels = unique(sg$group_name))
  gcol <- rgraph_palette(nlevels(grp), rgraph_opt(p, "palette", "course"))
  names(gcol) <- levels(grp)
  ha <- ComplexHeatmap::HeatmapAnnotation(
    Group = ComplexHeatmap::anno_block(gp = grid::gpar(fill = gcol, col = NA),
      labels = levels(grp), labels_gp = grid::gpar(col = "white", fontsize = 8, fontface = "bold")),
    show_annotation_name = FALSE, height = grid::unit(0.3, "cm"))
  ht <- ComplexHeatmap::Heatmap(sc, col = col_fun, cluster_rows = TRUE, cluster_columns = FALSE,
    column_split = grp, show_row_names = show_rn, top_annotation = ha,
    column_names_rot = 45, name = "Z-score")
  rgraph_save_base(p$outdir, nm, function() ComplexHeatmap::draw(ht),
                   width = w, height = h, dpi = dpi)
} else {
  rgraph_library(c("pheatmap"))
  pal <- grDevices::colorRampPalette(c(low, mid, high))(100)
  rgraph_ensure_dir(p$outdir)
  for (fmt in c("png", "pdf")) {
    f <- file.path(p$outdir, paste0(nm, ".", fmt))
    pheatmap::pheatmap(sub, scale = scale_by,
                       cluster_rows = rgraph_opt(p, "cluster_rows", TRUE),
                       cluster_cols = rgraph_opt(p, "cluster_cols", TRUE),
                       color = pal, border_color = NA,
                       show_rownames = show_rn, show_colnames = TRUE,
                       fontsize_col = 10, angle_col = 45,
                       width = w, height = h, filename = f)
    rgraph_emit(f)
  }
}
cat("RGRAPH_DONE: heatmap engine=", engine, "genes=", nrow(sub), "samples=", ncol(sub), "\n")
