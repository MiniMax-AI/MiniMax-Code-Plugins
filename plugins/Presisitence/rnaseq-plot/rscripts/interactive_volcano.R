# interactive_volcano.R —— 交互式火山图（plotly HTML，悬停显示基因/log2FC/-log10p）
# params: result(Degs.csv 或 Dse2_result.csv), outdir, sig_metric("pvalue"|"padj"),
#         pcut(0.05), log2fc(1), color_scheme("rb"|"rg"), include_no(bool,默认T), name
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("ggplot2", "dplyr", "plotly", "htmlwidgets"))

sig <- rgraph_opt(p, "sig_metric", "pvalue")
pcut <- rgraph_opt(p, "pcut", 0.05)
log2fc <- rgraph_opt(p, "log2fc", 1)

d <- read.csv(p$result, header = TRUE, check.names = FALSE)
d <- d[!is.na(d[[sig]]) & !is.na(d$log2FoldChange), ]
m <- d[[sig]]
d$color <- ifelse(m < pcut & d$log2FoldChange > log2fc, "Up",
           ifelse(m < pcut & d$log2FoldChange < -log2fc, "Down", "No"))
if (!isTRUE(rgraph_opt(p, "include_no", TRUE))) d <- d[d$color != "No", ]
cnt <- table(factor(d$color, levels = c("Up", "Down", "No")))
labs3 <- c(Up = sprintf("Up (%d)", cnt["Up"]), Down = sprintf("Down (%d)", cnt["Down"]),
           No = sprintf("No (%d)", cnt["No"]))
cols <- rgraph_updown_colors(rgraph_opt(p, "color_scheme", "rb"))

gcol <- if ("gene_id" %in% names(d)) d$gene_id else rownames(d)
pl <- ggplot2::ggplot(d, ggplot2::aes(x = log2FoldChange, y = -log10(.data[[sig]]), color = color,
        text = paste0("Gene: ", gcol, "<br>log2FC: ", round(log2FoldChange, 3),
                      "<br>-log10(", sig, "): ", round(-log10(.data[[sig]]), 3)))) +
  ggplot2::geom_point(alpha = 0.5, size = 1) +
  ggplot2::scale_color_manual(values = cols, breaks = c("Up", "Down", "No"), labels = labs3) +
  ggplot2::geom_hline(yintercept = -log10(pcut), linetype = "dashed", color = "grey") +
  ggplot2::geom_vline(xintercept = c(-log2fc, log2fc), linetype = "dashed", color = "grey") +
  ggplot2::labs(x = "log2 (Fold Change)", y = sprintf("-log10(%s)", sig), color = "Trend") +
  theme_rgraph()

ip <- plotly::ggplotly(pl, tooltip = "text", width = 850, height = 620)
rgraph_ensure_dir(p$outdir)
f <- file.path(p$outdir, paste0(rgraph_opt(p, "name", "volcano_interactive"), ".html"))
# selfcontained=TRUE 需 pandoc；默认 FALSE(会伴生一个 _files 依赖目录)，无需 pandoc
htmlwidgets::saveWidget(ip, f, selfcontained = isTRUE(rgraph_opt(p, "selfcontained", FALSE)),
                        title = "Interactive Volcano Plot")
rgraph_emit(f)
cat("RGRAPH_DONE: interactive_volcano up=", cnt["Up"], "down=", cnt["Down"], "\n")
