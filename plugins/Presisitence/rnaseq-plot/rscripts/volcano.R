# volcano.R —— 火山图（可标注 top-N 或自定义基因；色盲友好红蓝配色）
# params: result(Dse2_result.csv 路径), outdir, sig_metric("pvalue"|"padj",默认padj),
#         pcut(0.05), log2fc(1), color_scheme("rb"|"rg"), label(bool),
#         label_n(默认0), genes(可选,自定义标注基因向量), gene_col(默认gene_id),
#         dpi(300), width,height, name
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("ggplot2", "dplyr"))
use_repel <- requireNamespace("ggrepel", quietly = TRUE)

sig_metric <- rgraph_opt(p, "sig_metric", "padj")
pcut <- rgraph_opt(p, "pcut", 0.05)
log2fc <- rgraph_opt(p, "log2fc", 1)
gene_col <- rgraph_opt(p, "gene_col", "gene_id")

d <- read.csv(p$result, header = TRUE, check.names = FALSE)
if (!sig_metric %in% names(d)) stop(paste0("结果表缺少列: ", sig_metric))
d <- d[!is.na(d[[sig_metric]]) & !is.na(d$log2FoldChange), ]
m <- d[[sig_metric]]
d$color <- ifelse(m < pcut & d$log2FoldChange >  log2fc, "Up",
            ifelse(m < pcut & d$log2FoldChange < -log2fc, "Down", "No"))

cnt <- table(factor(d$color, levels = c("Up", "Down", "No")))
labs3 <- c(Up = sprintf("Up (%d)", cnt["Up"]), Down = sprintf("Down (%d)", cnt["Down"]),
           No = sprintf("No (%d)", cnt["No"]))
cols <- rgraph_updown_colors(rgraph_opt(p, "color_scheme", "rb"))

pl <- ggplot2::ggplot(d, ggplot2::aes(x = log2FoldChange, y = -log10(.data[[sig_metric]]),
                                      color = color)) +
  ggplot2::geom_point(alpha = 0.5, size = 1) +
  ggplot2::scale_color_manual(values = cols, breaks = c("Up", "Down", "No"), labels = labs3) +
  ggplot2::geom_hline(yintercept = -log10(pcut), linetype = "dashed", color = "grey") +
  ggplot2::geom_vline(xintercept = c(-log2fc, log2fc), linetype = "dashed", color = "grey") +
  ggplot2::labs(x = "log2 (Fold Change)", y = sprintf("-log10(%s)", sig_metric),
                color = sprintf("%s<%s\n|log2FC|>%s", sig_metric, pcut, log2fc)) +
  theme_rgraph() +
  ggplot2::guides(color = ggplot2::guide_legend(override.aes = list(size = 3)))

# ---- 标注基因：自定义清单优先，其次 top-N ----------------------------------
sel <- NULL
if (!is.null(p$genes)) {
  sel <- d[d[[gene_col]] %in% p$genes, ]
} else if (rgraph_opt(p, "label_n", 0) > 0) {
  sel <- d[d$color != "No", ]
  sel <- sel[order(sel[[sig_metric]]), ]
  sel <- utils::head(sel, rgraph_opt(p, "label_n", 10))
}
if (!is.null(sel) && nrow(sel) > 0) {
  aes_lab <- ggplot2::aes(x = log2FoldChange, y = -log10(.data[[sig_metric]]),
                          label = .data[[gene_col]])
  if (use_repel) pl <- pl + ggrepel::geom_text_repel(data = sel, mapping = aes_lab,
                                                      size = 3, color = "black", max.overlaps = Inf)
  else pl <- pl + ggplot2::geom_text(data = sel, mapping = aes_lab, size = 3, color = "black",
                                     vjust = -0.6)
}

rgraph_save(pl, p$outdir, rgraph_opt(p, "name", "volcano"),
            width = rgraph_opt(p, "width", 8), height = rgraph_opt(p, "height", 6.2),
            dpi = rgraph_opt(p, "dpi", 300))
cat("RGRAPH_DONE: volcano up=", cnt["Up"], "down=", cnt["Down"], "no=", cnt["No"], "\n")
