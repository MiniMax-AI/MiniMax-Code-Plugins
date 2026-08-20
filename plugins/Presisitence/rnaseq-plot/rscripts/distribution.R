# distribution.R —— 表达分布：箱线图 / 小提琴图 / 密度曲线
# params: fpkm, sample_group, outdir, kind("box"|"violin"|"density"),
#         palette, drop_zero_frac(默认0.5), dpi(300), width,height, name
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("dplyr", "tidyr", "ggplot2"))

kind <- rgraph_opt(p, "kind", "box")
fpkm <- rgraph_read_matrix(p$fpkm)
sg <- rgraph_read_sample_group(p$sample_group)
rgraph_check_samples(fpkm, sg$sample_name)

mat <- fpkm[, sg$sample_name, drop = FALSE]
# 去除 0 占比过高的行
zf <- rgraph_opt(p, "drop_zero_frac", 0.5)
keep <- rowSums(mat == 0 | is.na(mat)) < ncol(mat) * zf
mat <- mat[keep, , drop = FALSE]
mat[is.na(mat)] <- 0

long <- as.data.frame(mat) |>
  tidyr::pivot_longer(cols = dplyr::everything(), names_to = "Sample", values_to = "FPKM") |>
  dplyr::mutate(logFPKM = log2(FPKM + 1))
long$Group <- sg$group_name[match(long$Sample, sg$sample_name)]
long <- long |>
  dplyr::mutate(Sample = factor(Sample, levels = unique(sg$sample_name)),
                Group  = factor(Group,  levels = unique(sg$group_name)))

cols <- rgraph_palette(length(unique(sg$group_name)), rgraph_opt(p, "palette", "course"))

if (kind == "density") {
  pl <- ggplot2::ggplot(long, ggplot2::aes(x = logFPKM, color = Group, group = Sample)) +
    ggplot2::geom_density(linewidth = 0.6, alpha = 0.6) +
    ggplot2::scale_color_manual(values = cols) +
    ggplot2::labs(title = "Expression density", x = "log2(fpkm+1)", y = "Density") +
    theme_rgraph()
  w <- rgraph_opt(p, "width", 10); h <- rgraph_opt(p, "height", 6)
} else {
  base <- ggplot2::ggplot(long, ggplot2::aes(x = Sample, y = logFPKM, fill = Group, colour = Group)) +
    ggplot2::scale_color_manual(values = cols) +
    ggplot2::scale_fill_manual(values = cols) +
    ggplot2::labs(title = "Gene expression distribution", x = "Sample", y = "log2(fpkm+1)") +
    theme_rgraph() +
    ggplot2::theme(axis.text.x = ggplot2::element_text(angle = 45, hjust = 1))
  geom <- if (kind == "violin") ggplot2::geom_violin(alpha = 0.5, linewidth = 0.6)
          else ggplot2::geom_boxplot(alpha = 0.5, linewidth = 0.6, outlier.size = 0.4)
  pl <- base + geom
  w <- rgraph_opt(p, "width", 8); h <- rgraph_opt(p, "height", 8)
}

nm <- rgraph_opt(p, "name", switch(kind, violin = "violinplot", density = "density", "boxplot"))
rgraph_save(pl, p$outdir, nm, width = w, height = h, dpi = rgraph_opt(p, "dpi", 300))
cat("RGRAPH_DONE: distribution", kind, "genes=", nrow(mat), "\n")
