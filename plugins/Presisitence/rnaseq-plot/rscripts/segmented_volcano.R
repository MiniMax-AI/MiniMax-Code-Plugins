# segmented_volcano.R —— 分段式火山图（y 轴断裂，适合个别通路 p 值极端时）
# params: result(Dse2_result.csv), outdir, sig_metric("pvalue"|"padj"), pcut(0.05), log2fc(1),
#         color_scheme("rb"|"rg"), break_lower, break_upper(y 轴断裂区间), dpi,width,height, name
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("ggplot2", "dplyr", "ggbreak"))

sig <- rgraph_opt(p, "sig_metric", "pvalue")
pcut <- rgraph_opt(p, "pcut", 0.05)
log2fc <- rgraph_opt(p, "log2fc", 1)

d <- read.csv(p$result, header = TRUE, check.names = FALSE)
d <- d[!is.na(d[[sig]]) & !is.na(d$log2FoldChange), ]
m <- d[[sig]]
d$color <- ifelse(m < pcut & d$log2FoldChange > log2fc, "Up",
           ifelse(m < pcut & d$log2FoldChange < -log2fc, "Down", "No"))
cnt <- table(factor(d$color, levels = c("Up", "Down", "No")))
labs3 <- c(Up = sprintf("Up (%d)", cnt["Up"]), Down = sprintf("Down (%d)", cnt["Down"]),
           No = sprintf("No (%d)", cnt["No"]))
cols <- rgraph_updown_colors(rgraph_opt(p, "color_scheme", "rb"))

pl <- ggplot2::ggplot(d, ggplot2::aes(x = log2FoldChange, y = -log10(.data[[sig]]), color = color)) +
  ggplot2::geom_point(alpha = 0.5, size = 1) +
  ggplot2::scale_color_manual(values = cols, breaks = c("Up", "Down", "No"), labels = labs3) +
  ggplot2::geom_hline(yintercept = -log10(pcut), linetype = "dashed", color = "grey") +
  ggplot2::geom_vline(xintercept = c(-log2fc, log2fc), linetype = "dashed", color = "grey") +
  ggplot2::labs(x = "log2 (Fold Change)", y = sprintf("-log10(%s)", sig),
                color = sprintf("%s<%s\n|log2FC|>%s", sig, pcut, log2fc)) +
  theme_rgraph() +
  ggplot2::guides(color = ggplot2::guide_legend(override.aes = list(size = 3)))

# y 轴断裂：默认自动在数据主体与极端值之间断开
ymax <- max(-log10(d[[sig]]), na.rm = TRUE)
bl <- rgraph_opt(p, "break_lower", NULL); bu <- rgraph_opt(p, "break_upper", NULL)
if (is.null(bl) || is.null(bu)) {
  q <- stats::quantile(-log10(d[[sig]]), 0.995, na.rm = TRUE)
  if (ymax > q * 1.5) { bl <- ceiling(q); bu <- floor(ymax * 0.9) }
}
if (!is.null(bl) && !is.null(bu) && bu > bl)
  pl <- pl + ggbreak::scale_y_break(c(bl, bu), space = 0.1, scales = c(0.5, 1))

rgraph_save(pl, p$outdir, rgraph_opt(p, "name", "volcano_segmented"),
            width = rgraph_opt(p, "width", 8), height = rgraph_opt(p, "height", 6.2),
            dpi = rgraph_opt(p, "dpi", 300))
cat("RGRAPH_DONE: segmented_volcano up=", cnt["Up"], "down=", cnt["Down"], "\n")
