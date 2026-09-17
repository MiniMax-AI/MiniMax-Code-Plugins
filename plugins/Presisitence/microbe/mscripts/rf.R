# rf.R —— 随机森林分类 biomarker + 十折交叉验证误差曲线（对齐 Zhou2022 Fig2g-j）
# params: feature_table, metadata, outdir, taxonomy(可选,配合 level 汇总),
#   level(可选,如 "Genus"), top_n(重要性展示条数,默认 20), ntree(默认 1000),
#   cv(bool,默认T 做 10 折 rfcv), cv_fold(默认10), seed(默认123), dpi,width,height,name
# 输出: rf_importance.csv, rf_cv.csv(有CV时), rf_importance.png/pdf, rf_cv_error.png/pdf
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- microbe_load_params()
microbe_library(c("randomForest", "ggplot2"))

feature <- microbe_read_feature(p$feature_table)
meta <- microbe_read_metadata(p$metadata)
al <- microbe_align(feature, meta)
samples <- al$samples; meta <- al$meta

level <- microbe_opt(p, "level", NULL)
if (!is.null(level) && !is.null(p$taxonomy)) {
  taxonomy <- microbe_read_taxonomy(p$taxonomy)
  mat <- microbe_collapse(feature, taxonomy, level, samples)
  unit_label <- level
} else {
  mat <- microbe_feature_matrix(feature, samples)
  unit_label <- "feature"
}
ra <- microbe_relabund(mat)                      # 相对丰度，行=taxa 列=样本
X <- t(ra)                                       # 样本 x 特征
grp <- factor(meta$group_name[match(rownames(X), meta$sample_name)],
              levels = unique(meta$group_name))

seed <- microbe_opt(p, "seed", 123)
ntree <- microbe_opt(p, "ntree", 1000)
set.seed(seed)
rf <- randomForest::randomForest(x = X, y = grp, ntree = ntree, importance = TRUE)
oob <- rf$err.rate[nrow(rf$err.rate), "OOB"]
microbe_metric(sprintf("random_forest classes=%d features=%d ntree=%d OOB_error=%.3f",
                       nlevels(grp), ncol(X), ntree, oob))

imp <- randomForest::importance(rf)
gini <- if ("MeanDecreaseGini" %in% colnames(imp)) imp[, "MeanDecreaseGini"] else imp[, ncol(imp)]
# 每个特征富集于哪一组（均值相对丰度最大的组）
enr <- apply(ra, 1, function(x) {
  mv <- tapply(x, grp[match(colnames(ra), rownames(X))], mean)
  names(mv)[which.max(mv)]
})
impdf <- data.frame(taxon = rownames(imp), MeanDecreaseGini = as.numeric(gini),
                    enriched_in = enr[rownames(imp)], stringsAsFactors = FALSE)
impdf <- impdf[order(-impdf$MeanDecreaseGini), ]
microbe_write_csv(impdf, p$outdir, "rf_importance")

top_n <- min(microbe_opt(p, "top_n", 20), nrow(impdf))
show <- impdf[seq_len(top_n), ]
show$taxon <- factor(show$taxon, levels = rev(show$taxon))
gcols <- microbe_group_colors(grp)
pl <- ggplot2::ggplot(show, ggplot2::aes(x = MeanDecreaseGini, y = taxon, color = enriched_in)) +
  ggplot2::geom_segment(ggplot2::aes(x = 0, xend = MeanDecreaseGini, yend = taxon),
                        color = "grey70", linewidth = 0.5) +
  ggplot2::geom_point(size = 3) +
  ggplot2::scale_color_manual(values = gcols) +
  ggplot2::labs(x = "Mean Decrease Gini (importance)", y = unit_label,
                color = "Enriched in",
                title = sprintf("Random-forest biomarkers (OOB error = %.1f%%)", 100 * oob)) +
  theme_microbe()
microbe_save(pl, p$outdir, microbe_opt(p, "name", "rf_importance"),
             width = microbe_opt(p, "width", 7),
             height = microbe_opt(p, "height", max(3, top_n * 0.28 + 1.5)),
             dpi = microbe_opt(p, "dpi", 300))

# ---- 十折交叉验证误差曲线（确定最优 biomarker 数）-------------------------
if (isTRUE(microbe_opt(p, "cv", TRUE)) && ncol(X) >= 4) {
  set.seed(seed)
  cvres <- randomForest::rfcv(trainx = X, trainy = grp,
                              cv.fold = microbe_opt(p, "cv_fold", 10))
  cvdf <- data.frame(n_features = cvres$n.var, cv_error = cvres$error.cv)
  cvdf <- cvdf[order(cvdf$n_features), ]
  microbe_write_csv(cvdf, p$outdir, "rf_cv")
  optn <- cvdf$n_features[which.min(cvdf$cv_error)]
  microbe_metric(sprintf("rfcv optimal_n_features=%d min_cv_error=%.3f", optn, min(cvdf$cv_error)))
  plcv <- ggplot2::ggplot(cvdf, ggplot2::aes(x = n_features, y = cv_error)) +
    ggplot2::geom_line(color = "#3C5488", linewidth = 0.7) +
    ggplot2::geom_point(size = 2, color = "#3C5488") +
    ggplot2::geom_vline(xintercept = optn, linetype = "dashed", color = "#E64B35") +
    ggplot2::scale_x_log10() +
    ggplot2::annotate("text", x = optn, y = max(cvdf$cv_error),
                      label = sprintf("optimal = %d", optn), color = "#E64B35",
                      hjust = -0.1, size = 3) +
    ggplot2::labs(x = "Number of features (log10)", y = "Cross-validation error rate",
                  title = "Ten-fold cross-validation") +
    theme_microbe()
  microbe_save(plcv, p$outdir, "rf_cv_error",
               width = microbe_opt(p, "width", 6), height = 4.5,
               dpi = microbe_opt(p, "dpi", 300))
}

cat("MICROBE_DONE: rf unit=", unit_label, "features=", ncol(X), "OOB=", round(oob, 3), "\n")
