# stacked_volcano.R —— 堆叠火山图（多比较组 DEG 的 log2FC 抖动散点）
# 输入: DEG_data.csv (列 gene_id, log2FoldChange, pvalue[, TvsC 分组])
# params: deg_data, outdir, sig_metric("pvalue"|"padj"), pcut(0.05), log2fc(1),
#         group_col("TvsC"), top_n(每组每方向标注数,5), dpi(300), width(10),height(9), name
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("ggplot2", "dplyr"))
use_repel <- requireNamespace("ggrepel", quietly = TRUE)

sig <- rgraph_opt(p, "sig_metric", "pvalue")
pcut <- rgraph_opt(p, "pcut", 0.05)
log2fc <- rgraph_opt(p, "log2fc", 1)
gcol <- rgraph_opt(p, "group_col", "TvsC")
top_n <- rgraph_opt(p, "top_n", 5)

d <- read.csv(p$deg_data, check.names = FALSE)
if (!gcol %in% names(d)) d[[gcol]] <- "DEG"     # 无分组列时单组
d$regulate <- ifelse(d[[sig]] < pcut & d$log2FoldChange > log2fc, "Up",
              ifelse(d[[sig]] < pcut & d$log2FoldChange < -log2fc, "Down", "No"))
d <- d[d$regulate != "No", ]
d[[gcol]] <- factor(d[[gcol]], levels = unique(d[[gcol]]))
set.seed(123)
d$xj <- as.numeric(d[[gcol]]) + runif(nrow(d), -0.18, 0.18)

# 每组背景柱（min/max*1.2）
bar <- d %>% dplyr::group_by(.g = .data[[gcol]]) %>%
  dplyr::summarise(minv = min(log2FoldChange) * 1.2, maxv = max(log2FoldChange) * 1.2,
                   center = mean(as.numeric(.data[[gcol]])), .groups = "drop")
bar$xc <- as.numeric(factor(bar$.g, levels = levels(d[[gcol]])))
bcols <- rgraph_palette(nrow(bar), rgraph_opt(p, "palette", "course"))

# 标注 top_n
lab <- d %>% dplyr::group_by(.data[[gcol]]) %>%
  dplyr::slice_max(log2FoldChange, n = top_n) %>% dplyr::ungroup()
lab <- rbind(lab, d %>% dplyr::group_by(.data[[gcol]]) %>%
               dplyr::slice_min(log2FoldChange, n = top_n) %>% dplyr::ungroup())
lab <- lab[!duplicated(lab$gene_id), ]

pl <- ggplot2::ggplot(d, ggplot2::aes(x = xj, y = log2FoldChange)) +
  ggplot2::geom_col(data = bar, ggplot2::aes(x = xc, y = minv), fill = rep(bcols, 1), alpha = 0.15, width = 0.8) +
  ggplot2::geom_col(data = bar, ggplot2::aes(x = xc, y = maxv), fill = rep(bcols, 1), alpha = 0.15, width = 0.8) +
  ggplot2::geom_point(ggplot2::aes(size = abs(log2FoldChange), alpha = abs(log2FoldChange), color = regulate)) +
  ggplot2::scale_color_manual(values = c(Down = "#3288bd", Up = "#d92523")) +
  ggplot2::scale_size_continuous(range = c(0.5, 4)) +
  ggplot2::scale_alpha_continuous(range = c(0.2, 0.85)) +
  ggplot2::geom_tile(data = bar, ggplot2::aes(x = xc, y = 0), height = 0.8, width = 0.9,
                     fill = bcols, alpha = 0.85) +
  ggplot2::geom_text(data = bar, ggplot2::aes(x = xc, y = 0, label = .g), size = 5) +
  ggplot2::scale_x_continuous(breaks = bar$xc, labels = bar$.g) +
  ggplot2::labs(x = NULL, y = "log2FoldChange", color = "Trend", size = "|log2FoldChange|") +
  theme_rgraph() +
  ggplot2::guides(color = ggplot2::guide_legend(override.aes = list(size = 3)), alpha = "none")

if (use_repel && nrow(lab) > 0)
  pl <- pl + ggrepel::geom_text_repel(data = lab, ggplot2::aes(x = xj, y = log2FoldChange, label = gene_id),
                                      size = 3.5, max.overlaps = Inf, segment.size = 0.3, segment.color = "gray40")

rgraph_save(pl, p$outdir, rgraph_opt(p, "name", "multi_volcano"),
            width = rgraph_opt(p, "width", 10), height = rgraph_opt(p, "height", 9),
            dpi = rgraph_opt(p, "dpi", 300))
cat("RGRAPH_DONE: stacked_volcano groups=", nrow(bar), "DEG=", nrow(d), "\n")
