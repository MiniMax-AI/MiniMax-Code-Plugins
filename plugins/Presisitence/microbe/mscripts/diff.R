# diff.R —— 差异丰度分析（DESeq2 / edgeR / Wilcoxon）（对齐 Liu2023 Fig3a,b / Zhou2022 EdgeR）
# params: feature_table, metadata, outdir, taxonomy(可选，配合 level 汇总),
#   level(可选，如 "Genus"；给出则按该层级汇总后做差异，否则按 feature),
#   method("auto"|"deseq2"|"edger"|"wilcox"，默认 auto: 有 DESeq2 用 deseq2 否则 edger),
#   group_test/group_ref(指定两组；缺省用 metadata 的 TvsC=treatment/control，再缺省取前两组),
#   padj(0.05), log2fc(1), min_count(平均计数下限,默认1), min_prev(最小检出样本数,默认2),
#   kind("bar"|"volcano"，默认 bar), top_n(bar 展示上限,默认 30), dpi,width,height,name
# 输出: diff_result.csv + diff_<kind>.png/pdf
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- microbe_load_params()
microbe_library(c("ggplot2", "dplyr"))

feature <- microbe_read_feature(p$feature_table)
meta <- microbe_read_metadata(p$metadata)
al <- microbe_align(feature, meta)
samples <- al$samples; meta <- al$meta

# ---- 计数矩阵：按层级汇总或按 feature -------------------------------------
level <- microbe_opt(p, "level", NULL)
if (!is.null(level) && !is.null(p$taxonomy)) {
  taxonomy <- microbe_read_taxonomy(p$taxonomy)
  mat <- microbe_collapse(feature, taxonomy, level, samples)
  unit_label <- level
} else {
  mat <- microbe_feature_matrix(feature, samples)
  unit_label <- "feature"
}
mat <- round(mat)

# ---- 选两组：group_test/group_ref → TvsC → 前两组 --------------------------
gname <- meta$group_name[match(colnames(mat), meta$sample_name)]
if (!is.null(p$group_test) && !is.null(p$group_ref)) {
  g_test <- p$group_test; g_ref <- p$group_ref
} else if ("TvsC" %in% names(meta) && all(c("treatment", "control") %in% meta$TvsC)) {
  g_test <- unique(meta$group_name[meta$TvsC == "treatment"])[1]
  g_ref  <- unique(meta$group_name[meta$TvsC == "control"])[1]
} else {
  gs <- unique(gname)
  if (length(gs) < 2) stop("分组不足两组，无法差异分析")
  g_ref <- gs[1]; g_test <- gs[2]
}
keep_s <- gname %in% c(g_test, g_ref)
mat <- mat[, keep_s, drop = FALSE]
grp <- factor(gname[keep_s], levels = c(g_ref, g_test))

# ---- 过滤低丰度 ------------------------------------------------------------
min_count <- microbe_opt(p, "min_count", 1)
min_prev  <- microbe_opt(p, "min_prev", 2)
keep_f <- rowMeans(mat) >= min_count & rowSums(mat > 0) >= min_prev
mat <- mat[keep_f, , drop = FALSE]
if (nrow(mat) < 2) stop("过滤后可分析的类群不足 2 个，请放宽 min_count/min_prev")

# ---- 方法选择 --------------------------------------------------------------
method <- microbe_opt(p, "method", "auto")
if (identical(method, "auto")) method <- if (microbe_has("DESeq2")) "deseq2" else "edger"

if (method == "deseq2") {
  microbe_library(c("DESeq2"))
  coldata <- data.frame(row.names = colnames(mat), group = grp)
  dds <- DESeq2::DESeqDataSetFromMatrix(mat, coldata, design = ~group)
  dds <- DESeq2::estimateSizeFactors(dds, type = "poscounts")  # 微生物组多零，用 poscounts
  dds <- DESeq2::DESeq(dds, fitType = "local", quiet = TRUE)
  res <- as.data.frame(DESeq2::results(dds, contrast = c("group", g_test, g_ref)))
  stats <- data.frame(taxon = rownames(res), baseMean = res$baseMean,
                      log2FoldChange = res$log2FoldChange, pvalue = res$pvalue, padj = res$padj)
} else if (method == "edger") {
  microbe_library(c("edgeR"))
  dge <- edgeR::DGEList(counts = mat, group = grp)
  dge <- edgeR::calcNormFactors(dge, method = "TMM")
  dge <- edgeR::estimateDisp(dge)
  et <- edgeR::exactTest(dge, pair = c(g_ref, g_test))   # logFC = test/ref
  tt <- edgeR::topTags(et, n = Inf, adjust.method = "BH", sort.by = "none")$table
  stats <- data.frame(taxon = rownames(tt), baseMean = 2^tt$logCPM,
                      log2FoldChange = tt$logFC, pvalue = tt$PValue, padj = tt$FDR)
} else if (method == "wilcox") {
  ra <- microbe_relabund(mat)
  is_t <- grp == g_test
  pv <- apply(ra, 1, function(x) tryCatch(stats::wilcox.test(x[is_t], x[!is_t])$p.value, error = function(e) NA))
  mt <- rowMeans(ra[, is_t, drop = FALSE]); mr <- rowMeans(ra[, !is_t, drop = FALSE])
  lfc <- log2((mt + 1e-6) / (mr + 1e-6))
  stats <- data.frame(taxon = rownames(ra), baseMean = rowMeans(ra),
                      log2FoldChange = lfc, pvalue = pv, padj = p.adjust(pv, "BH"))
} else {
  stop(paste0("未知 method: ", method))
}

padj_cut <- microbe_opt(p, "padj", 0.05)
log2fc <- microbe_opt(p, "log2fc", 1)
stats <- stats[!is.na(stats$log2FoldChange), ]
stats$padj[is.na(stats$padj)] <- 1
stats$sig <- stats$padj < padj_cut & abs(stats$log2FoldChange) > log2fc
stats$enriched_in <- ifelse(stats$log2FoldChange > 0, g_test, g_ref)
stats$enriched_in[!stats$sig] <- "n.s."
stats <- stats[order(stats$padj, -abs(stats$log2FoldChange)), ]
microbe_write_csv(stats, p$outdir, "diff_result")
microbe_metric(sprintf("diff method=%s test=%s ref=%s sig=%d (up_in_%s=%d, up_in_%s=%d)",
                       method, g_test, g_ref, sum(stats$sig), g_test,
                       sum(stats$sig & stats$log2FoldChange > 0), g_ref,
                       sum(stats$sig & stats$log2FoldChange < 0)))

kind <- microbe_opt(p, "kind", "bar")
gcols <- stats::setNames(microbe_palette(2, "group"), c(g_ref, g_test))
gcols["n.s."] <- "grey75"

if (identical(kind, "volcano")) {
  stats$neglogp <- -log10(pmax(stats$padj, 1e-300))
  pl <- ggplot2::ggplot(stats, ggplot2::aes(x = log2FoldChange, y = neglogp, color = enriched_in)) +
    ggplot2::geom_point(alpha = 0.75, size = 1.8) +
    ggplot2::scale_color_manual(values = gcols) +
    ggplot2::geom_hline(yintercept = -log10(padj_cut), linetype = "dashed", color = "grey60") +
    ggplot2::geom_vline(xintercept = c(-log2fc, log2fc), linetype = "dashed", color = "grey60") +
    ggplot2::labs(x = sprintf("log2 fold change (%s / %s)", g_test, g_ref),
                  y = "-log10(FDR)", color = "Enriched in") +
    theme_microbe()
  w <- microbe_opt(p, "width", 7); h <- microbe_opt(p, "height", 6)
} else {
  sig <- stats[stats$sig, , drop = FALSE]
  if (nrow(sig) == 0) {
    sig <- utils::head(stats[order(stats$padj), ], min(10, nrow(stats)))
    microbe_metric("无显著差异类群，bar 图展示 padj 最小的若干条以供检视")
  }
  sig <- utils::head(sig[order(-abs(sig$log2FoldChange)), ], microbe_opt(p, "top_n", 30))
  sig <- sig[order(sig$log2FoldChange), ]
  sig$taxon <- factor(sig$taxon, levels = sig$taxon)
  pl <- ggplot2::ggplot(sig, ggplot2::aes(x = log2FoldChange, y = taxon, fill = enriched_in)) +
    ggplot2::geom_col(width = 0.7) +
    ggplot2::scale_fill_manual(values = gcols) +
    ggplot2::geom_vline(xintercept = 0, color = "black", linewidth = 0.3) +
    ggplot2::labs(x = sprintf("log2 fold change (%s / %s)", g_test, g_ref),
                  y = unit_label, fill = "Enriched in") +
    theme_microbe()
  w <- microbe_opt(p, "width", 7)
  h <- microbe_opt(p, "height", max(3, nrow(sig) * 0.22 + 1.5))
}

microbe_save(pl, p$outdir, microbe_opt(p, "name", paste0("diff_", kind)),
             width = w, height = h, dpi = microbe_opt(p, "dpi", 300))
cat("MICROBE_DONE: diff method=", method, "unit=", unit_label, "n=", nrow(stats),
    "sig=", sum(stats$sig), "\n")
