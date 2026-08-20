# gene_bar.R —— 单基因表达柱形图（对照 vs 处理，均值±SEM，显著性星号）
# params: deg(Deg_all.csv, 含 pvalue 与各样本归一化列), sample_group(需 TvsC 与 group/group_name),
#         gene_list(CSV, 列 gene_id) 或 genes(基因向量), outdir, dpi(300), width(4),height(5)
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("dplyr", "tidyr", "ggplot2"))

deg <- read.csv(p$deg, check.names = FALSE)
sg <- rgraph_read_sample_group(p$sample_group)
if (!is.null(p$genes)) genes <- p$genes else genes <- read.csv(p$gene_list, check.names = FALSE)$gene_id

deg$difference <- dplyr::case_when(deg$pvalue < 0.001 ~ "***", deg$pvalue < 0.01 ~ "**",
                                   deg$pvalue < 0.05 ~ "*", TRUE ~ "")
ctrl <- sg$sample_name[sg$TvsC == "control"]
trt  <- sg$sample_name[sg$TvsC == "treatment"]
if (length(ctrl) == 0 || length(trt) == 0) {  # 无 TvsC 时按前两组
  gs <- unique(sg$group); trt <- sg$sample_name[sg$group == gs[1]]; ctrl <- sg$sample_name[sg$group == gs[2]]
}
ctrl_name <- sg$group_name[match(ctrl[1], sg$sample_name)]
trt_name  <- sg$group_name[match(trt[1], sg$sample_name)]

summ <- function(row, cols) {
  v <- as.numeric(row[cols]); c(mean = mean(v), sem = ifelse(length(v) > 1, sd(v) / sqrt(length(v)), 0))
}
n_ok <- 0
for (g in genes) {
  cg <- deg[deg$gene_id == g, ]
  if (nrow(cg) == 0) next
  sc <- summ(cg[1, ], ctrl); st <- summ(cg[1, ], trt)
  pd <- data.frame(group = factor(c(ctrl_name, trt_name), levels = c(ctrl_name, trt_name)),
                   mean_exp = c(sc["mean"], st["mean"]), sem = c(sc["sem"], st["sem"]),
                   difference = c("", cg$difference[1]))
  pl <- ggplot2::ggplot(pd, ggplot2::aes(x = group, y = mean_exp, fill = group)) +
    ggplot2::geom_col(width = 0.6) +
    ggplot2::scale_fill_manual(values = setNames(c("#1f77b4", "#ff7f0e"), c(ctrl_name, trt_name)), name = "Group") +
    ggplot2::geom_errorbar(ggplot2::aes(ymin = mean_exp - sem, ymax = mean_exp + sem), width = 0.2) +
    ggplot2::geom_text(ggplot2::aes(y = mean_exp + sem, label = difference), vjust = 0, size = 5) +
    ggplot2::labs(title = g, y = "Normalized Count", x = NULL) +
    theme_rgraph() +
    ggplot2::scale_y_continuous(expand = ggplot2::expansion(mult = c(0, 0.1)))
  rgraph_save(pl, p$outdir, paste0(g, "_Expression"),
              width = rgraph_opt(p, "width", 4), height = rgraph_opt(p, "height", 5),
              dpi = rgraph_opt(p, "dpi", 300))
  n_ok <- n_ok + 1
}
cat("RGRAPH_DONE: gene_bar genes=", n_ok, "\n")
