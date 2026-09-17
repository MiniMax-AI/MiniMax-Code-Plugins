# corr.R —— 微生物-代谢物/环境因子 相关热图 (Spearman/Pearson, r 填色 + 显著性星号)
#   对齐 Liu2023 Fig2f (氨基酸/毒素与丰度的相关矩阵, r + P)
# params: feature_table, metadata, outdir, taxonomy(可选,配合 level 汇总),
#   level(可选,如 "Genus"), variables(metadata 中的数值列名向量=代谢物/环境因子;
#     缺省自动取除分组外的全部数值列), features(可选,限定微生物类群向量),
#   method("spearman"|"pearson"，默认 spearman), top_n(微生物类群上限,默认 30),
#   padjust(bool,默认T BH), star(bool,默认T 显著性星号), dpi,width,height,name
# 输出: corr_r.csv, corr_p.csv, corr_heatmap.png/pdf
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- microbe_load_params()
microbe_library(c("Hmisc", "ggplot2", "reshape2"))

feature <- microbe_read_feature(p$feature_table)
meta <- microbe_read_metadata(p$metadata)
al <- microbe_align(feature, meta)
samples <- al$samples; meta <- al$meta

# 微生物矩阵（层级汇总或 feature），相对丰度
level <- microbe_opt(p, "level", NULL)
if (!is.null(level) && !is.null(p$taxonomy)) {
  taxonomy <- microbe_read_taxonomy(p$taxonomy)
  mat <- microbe_collapse(feature, taxonomy, level, samples)
} else {
  mat <- microbe_feature_matrix(feature, samples)
}
if (!is.null(p$features)) mat <- mat[rownames(mat) %in% p$features, , drop = FALSE]
ra <- microbe_relabund(mat)
top_n <- microbe_opt(p, "top_n", 30)
if (nrow(ra) > top_n) ra <- ra[order(rowMeans(ra), decreasing = TRUE)[seq_len(top_n)], , drop = FALSE]

# 环境/代谢物变量：指定列或自动取数值列
reserved <- c("sample_name", "group", "group_name", "TvsC")
vars <- microbe_opt(p, "variables", NULL)
if (is.null(vars)) {
  numcols <- names(meta)[vapply(meta, function(x) is.numeric(x) || !any(is.na(suppressWarnings(as.numeric(as.character(x))))), logical(1))]
  vars <- setdiff(numcols, reserved)
}
vars <- intersect(vars, names(meta))
if (length(vars) < 1) stop("未找到可用的数值型变量(代谢物/环境因子)，请通过 variables 指定 metadata 列名")
env <- sapply(vars, function(v) as.numeric(as.character(meta[[v]][match(colnames(ra), meta$sample_name)])))
env <- as.matrix(env); rownames(env) <- colnames(ra)
env <- env[, apply(env, 2, function(x) stats::sd(x, na.rm = TRUE) > 0), drop = FALSE]
if (ncol(env) < 1) stop("数值变量方差为 0，无法计算相关")

# ---- 相关：微生物(行) × 变量(列) ------------------------------------------
method <- microbe_opt(p, "method", "spearman")
combined <- cbind(t(ra), env)
rc <- Hmisc::rcorr(as.matrix(combined), type = method)
taxa <- rownames(ra); vv <- colnames(env)
R <- rc$r[taxa, vv, drop = FALSE]
P <- rc$P[taxa, vv, drop = FALSE]
if (isTRUE(microbe_opt(p, "padjust", TRUE))) {
  P[] <- p.adjust(as.vector(P), method = "BH")
}
microbe_write_csv(data.frame(taxon = rownames(R), R, check.names = FALSE), p$outdir, "corr_r")
microbe_write_csv(data.frame(taxon = rownames(P), P, check.names = FALSE), p$outdir, "corr_p")

long <- reshape2::melt(R, varnames = c("taxon", "variable"), value.name = "r")
longp <- reshape2::melt(P, varnames = c("taxon", "variable"), value.name = "p")
long$p <- longp$p
long$star <- ifelse(long$p < 0.001, "***", ifelse(long$p < 0.01, "**", ifelse(long$p < 0.05, "*", "")))
long$taxon <- factor(long$taxon, levels = rev(taxa))
long$variable <- factor(long$variable, levels = vv)

pl <- ggplot2::ggplot(long, ggplot2::aes(x = variable, y = taxon, fill = r)) +
  ggplot2::geom_tile(color = "white", linewidth = 0.4) +
  ggplot2::scale_fill_gradient2(low = "#4575b4", mid = "white", high = "#d73027",
                                midpoint = 0, limits = c(-1, 1), name = "r") +
  ggplot2::labs(x = NULL, y = NULL,
                title = sprintf("%s correlation", tools::toTitleCase(method))) +
  theme_microbe() +
  ggplot2::theme(axis.text.x = ggplot2::element_text(angle = 45, hjust = 1),
                 panel.border = ggplot2::element_blank(), axis.ticks = ggplot2::element_blank())
if (isTRUE(microbe_opt(p, "star", TRUE))) {
  pl <- pl + ggplot2::geom_text(ggplot2::aes(label = star), color = "black", size = 3)
}

microbe_save(pl, p$outdir, microbe_opt(p, "name", "corr_heatmap"),
             width = microbe_opt(p, "width", max(4, ncol(env) * 0.5 + 2.5)),
             height = microbe_opt(p, "height", max(3.5, nrow(R) * 0.28 + 1.5)),
             dpi = microbe_opt(p, "dpi", 300))
cat("MICROBE_DONE: corr taxa=", nrow(R), "variables=", ncol(env), "method=", method, "\n")
