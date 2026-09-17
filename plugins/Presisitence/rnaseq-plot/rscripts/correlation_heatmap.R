# correlation_heatmap.R —— 样本间 Pearson 相关性热图
# params: fpkm(路径), sample_group(路径), outdir, dpi(默认300), width,height, name
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("dplyr", "ggplot2", "scales", "reshape2"))

fpkm <- rgraph_read_matrix(p$fpkm)
sg <- rgraph_read_sample_group(p$sample_group)
rgraph_check_samples(fpkm, sg$sample_name)

mat <- fpkm[, sg$sample_name, drop = FALSE]
mat[is.na(mat)] <- 0
logm <- log2(mat + 1)

cor_mat <- cor(logm, use = "pairwise.complete.obs")
cor_df <- reshape2::melt(cor_mat)

low  <- rgraph_opt(p, "low_color", "white")
high <- rgraph_opt(p, "high_color", "blue")

pl <- ggplot2::ggplot(cor_df, ggplot2::aes(x = Var2, y = Var1, fill = value)) +
  ggplot2::geom_tile(color = "white", linewidth = 0.5) +
  ggplot2::scale_fill_gradient(low = low, high = high, name = expression(R^2)) +
  ggplot2::geom_text(ggplot2::aes(label = round(value, 3)), color = "black", size = 3) +
  ggplot2::labs(x = NULL, y = NULL, title = "Pearson correlation between samples") +
  theme_rgraph() +
  ggplot2::theme(axis.text.x = ggplot2::element_text(angle = 45, hjust = 1)) +
  ggplot2::coord_fixed()

rgraph_save(pl, p$outdir, rgraph_opt(p, "name", "correlation"),
            width = rgraph_opt(p, "width", 6), height = rgraph_opt(p, "height", 6),
            dpi = rgraph_opt(p, "dpi", 300))
cat("RGRAPH_DONE: correlation_heatmap samples=", ncol(mat), "\n")
