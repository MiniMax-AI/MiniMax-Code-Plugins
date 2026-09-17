# pca.R —— 样本 PCA (log2(fpkm+1) + prcomp)，支持置信椭圆与 ggrepel 标签
# params: fpkm, sample_group, outdir, ellipse(bool,默认F), label(bool,默认T),
#         palette("course"|"colorblind"), dpi(300), width,height, name
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("dplyr", "ggplot2"))
use_repel <- requireNamespace("ggrepel", quietly = TRUE)

fpkm <- rgraph_read_matrix(p$fpkm)
sg <- rgraph_read_sample_group(p$sample_group)
rgraph_check_samples(fpkm, sg$sample_name)

mat <- fpkm[, sg$sample_name, drop = FALSE]
mat[is.na(mat)] <- 0
mat <- mat[rowSums(mat != 0) > 0, , drop = FALSE]                 # 去全 0 行
mat <- mat[apply(mat, 1, function(x) length(unique(x)) > 1), , drop = FALSE]  # 去常数行
logm <- log2(mat + 1)

pca <- prcomp(t(logm), scale. = TRUE)
varexp <- (pca$sdev^2) / sum(pca$sdev^2)
scores <- as.data.frame(pca$x)
scores$Sample <- rownames(scores)
scores$Group <- sg$group_name[match(scores$Sample, sg$sample_name)]
scores$Group <- factor(scores$Group, levels = unique(sg$group_name))

cols <- rgraph_palette(length(levels(scores$Group)), rgraph_opt(p, "palette", "course"))

pl <- ggplot2::ggplot(scores, ggplot2::aes(x = PC1, y = PC2, color = Group)) +
  ggplot2::geom_point(size = 4, alpha = 0.85) +
  ggplot2::scale_color_manual(values = cols) +
  ggplot2::geom_hline(yintercept = 0, linetype = "dashed", color = "#bebebe") +
  ggplot2::geom_vline(xintercept = 0, linetype = "dashed", color = "#bebebe") +
  ggplot2::labs(title = "Principal Component Analysis (PCA)",
                x = sprintf("PC1 (%.2f%%)", varexp[1] * 100),
                y = sprintf("PC2 (%.2f%%)", varexp[2] * 100)) +
  theme_rgraph()

if (isTRUE(rgraph_opt(p, "ellipse", FALSE)) && nlevels(scores$Group) > 1)
  pl <- pl + ggplot2::stat_ellipse(level = 0.95, linewidth = 0.3)

if (isTRUE(rgraph_opt(p, "label", TRUE))) {
  if (use_repel) {
    pl <- pl + ggrepel::geom_text_repel(ggplot2::aes(label = Sample), size = 3,
                                        color = "black", max.overlaps = Inf)
  } else {
    pl <- pl + ggplot2::geom_text(ggplot2::aes(label = Sample), vjust = -0.6, size = 2.5,
                                  color = "black")
  }
}

rgraph_save(pl, p$outdir, rgraph_opt(p, "name", "pca"),
            width = rgraph_opt(p, "width", 6), height = rgraph_opt(p, "height", 5.5),
            dpi = rgraph_opt(p, "dpi", 300))
cat("RGRAPH_DONE: pca genes_used=", nrow(logm), "PC1=", round(varexp[1] * 100, 2),
    "PC2=", round(varexp[2] * 100, 2), "\n")
