# alpha.R —— α多样性指数箱线图 + 组间检验（对齐 Liu2023 Fig1a,b,d,e / Zhou2022 Fig1e,f）
# params: feature_table, metadata, outdir,
#   metrics(默认 c("Observed","Chao1","Shannon","Simpson"))
#   test("wilcox"|"t.test"|"anova"|"kruskal"，默认 wilcox)
#   rarefy(bool,默认F), depth(抽平深度,缺省取最小样本), palette,
#   pairwise(bool,默认T 画两两比较括号), dpi,width,height,name
# 输出: alpha_diversity.csv(各样本各指数) + alpha_boxplot.png/pdf
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- microbe_load_params()
microbe_library(c("vegan", "ggplot2", "dplyr", "tidyr"))
use_pubr <- microbe_has("ggpubr")

feature <- microbe_read_feature(p$feature_table)
meta <- microbe_read_metadata(p$metadata)
al <- microbe_align(feature, meta)
samples <- al$samples; meta <- al$meta

m <- microbe_feature_matrix(feature, samples)   # 行=feature 列=样本
if (isTRUE(microbe_opt(p, "rarefy", FALSE))) {
  rr <- microbe_rarefy(m, depth = microbe_opt(p, "depth", NULL))
  m <- rr$mat
  samples <- colnames(m)
  meta <- meta[meta$sample_name %in% samples, , drop = FALSE]
  microbe_metric("rarefy depth=", rr$depth, " dropped_samples=", rr$dropped)
}

comm <- t(round(m))                              # vegan 要求 行=样本
metrics <- microbe_opt(p, "metrics", c("Observed", "Chao1", "Shannon", "Simpson"))

est <- vegan::estimateR(comm)                    # S.obs, S.chao1, se.chao1, S.ACE, se.ACE
idx <- data.frame(
  sample_name = rownames(comm),
  Observed = est["S.obs", ],
  Chao1    = est["S.chao1", ],
  ACE      = est["S.ACE", ],
  Shannon  = vegan::diversity(comm, index = "shannon"),
  Simpson  = vegan::diversity(comm, index = "simpson"),
  InvSimpson = vegan::diversity(comm, index = "invsimpson"),
  Pielou   = vegan::diversity(comm, index = "shannon") / log(vegan::specnumber(comm)),
  check.names = FALSE, row.names = NULL
)
idx$group <- meta$group_name[match(idx$sample_name, meta$sample_name)]
microbe_write_csv(idx, p$outdir, "alpha_diversity")

metrics <- intersect(metrics, names(idx))
long <- tidyr::pivot_longer(idx[, c("sample_name", "group", metrics)],
                            cols = all_of(metrics), names_to = "metric", values_to = "value")
long$metric <- factor(long$metric, levels = metrics)
long$group <- factor(long$group, levels = unique(meta$group_name))

cols <- microbe_group_colors(long$group)
pl <- ggplot2::ggplot(long, ggplot2::aes(x = group, y = value, fill = group)) +
  ggplot2::geom_boxplot(width = 0.6, outlier.shape = NA, alpha = 0.85) +
  ggplot2::geom_jitter(width = 0.15, size = 1.2, alpha = 0.6, color = "black") +
  ggplot2::scale_fill_manual(values = cols) +
  ggplot2::facet_wrap(~metric, scales = "free_y", nrow = 1) +
  ggplot2::labs(x = NULL, y = "Alpha diversity index", fill = "Group") +
  theme_microbe() +
  ggplot2::theme(axis.text.x = ggplot2::element_text(angle = 30, hjust = 1))

test <- microbe_opt(p, "test", "wilcox")
if (use_pubr && nlevels(long$group) >= 2) {
  if (nlevels(long$group) == 2 || isTRUE(microbe_opt(p, "pairwise", TRUE))) {
    pw_method <- if (identical(test, "t.test")) "t.test" else "wilcox.test"
    pl <- pl + ggpubr::stat_compare_means(comparisons = microbe_comparisons(long$group),
                                          method = pw_method, size = 2.8)
  }
  if (nlevels(long$group) > 2) {
    glob <- if (identical(test, "anova")) "anova" else "kruskal.test"
    pl <- pl + ggpubr::stat_compare_means(method = glob, label = "p.format",
                                          size = 2.8, label.y.npc = "bottom")
  }
} else if (!use_pubr) {
  microbe_metric("ggpubr 未安装：箱线图正常输出，但未叠加显著性标注")
}

n_metric <- length(metrics)
microbe_save(pl, p$outdir, microbe_opt(p, "name", "alpha_boxplot"),
             width = microbe_opt(p, "width", max(3, n_metric * 2.2)),
             height = microbe_opt(p, "height", 4.5), dpi = microbe_opt(p, "dpi", 300))
cat("MICROBE_DONE: alpha samples=", length(samples), "groups=", nlevels(long$group),
    "metrics=", paste(metrics, collapse = "/"), "\n")
