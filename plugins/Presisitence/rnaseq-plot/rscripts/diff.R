# diff.R —— 差异表达分析（DESeq2 / edgeR / edgeR_norep / limma）
# params: count, sample_group, outdir, method("deseq2"|"edger"|"edger_norep"|"limma"),
#         sig_metric("padj"|"pvalue",默认padj), pcut(0.05), log2fc(1),
#         min_mean_count(1), dispersion(edger_norep用,默认0.1)
# 输出: 01.Dse2_result.csv, 02.Deg_all.csv, 03.Deg_down.csv, 04.Deg_up.csv
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()

method <- rgraph_opt(p, "method", "deseq2")
sig_metric <- rgraph_opt(p, "sig_metric", "padj")
pcut <- rgraph_opt(p, "pcut", 0.05)
log2fc <- rgraph_opt(p, "log2fc", 1)
min_mean <- rgraph_opt(p, "min_mean_count", 1)

rgraph_library(c("dplyr"))
count <- rgraph_read_matrix(p$count)
sg <- rgraph_read_sample_group(p$sample_group)
rgraph_check_samples(count, sg$sample_name)

# 实验/对照组：优先 TvsC，其次取前两组
if (any(!is.na(sg$TvsC)) && all(c("treatment", "control") %in% sg$TvsC)) {
  treatment_g <- unique(sg$group[sg$TvsC == "treatment"])[1]
  control_g   <- unique(sg$group[sg$TvsC == "control"])[1]
} else {
  gs <- unique(sg$group)
  if (length(gs) < 2) stop("分组不足两组，无法差异分析")
  treatment_g <- gs[1]; control_g <- gs[2]
}

mat <- count[, c("gene_id", sg$sample_name)]
rownames(mat) <- mat$gene_id; mat$gene_id <- NULL
mat[is.na(mat)] <- 0
grp <- factor(sg$group[match(colnames(mat), sg$sample_name)])

# ---- 各方法产出 stats(gene_id,log2FoldChange,pvalue,padj) 与 norm(矩阵) -----
if (method == "deseq2") {
  rgraph_library(c("DESeq2"))
  coldata <- data.frame(row.names = colnames(mat), group = grp)
  dds <- DESeq2::DESeqDataSetFromMatrix(round(as.matrix(mat)), coldata, design = ~group)
  dds <- DESeq2::DESeq(dds)
  norm <- as.data.frame(DESeq2::counts(dds, normalized = TRUE))
  res <- as.data.frame(DESeq2::results(dds, contrast = c("group", treatment_g, control_g)))
  stats <- data.frame(gene_id = rownames(res), log2FoldChange = res$log2FoldChange,
                      pvalue = res$pvalue, padj = res$padj)
} else if (method %in% c("edger", "edger_norep")) {
  rgraph_library(c("edgeR"))
  dge <- edgeR::DGEList(counts = as.matrix(mat), group = grp)
  dge <- edgeR::calcNormFactors(dge, method = "TMM")
  if (method == "edger_norep") {
    disp <- rgraph_opt(p, "dispersion", 0.1)
    dge <- edgeR::estimateDisp(dge, trend = "none", tagwise = FALSE)
    dge$common.dispersion <- disp
    dge$trended.dispersion <- rep(disp, nrow(dge))
    dge$tagwise.dispersion <- rep(disp, nrow(dge))
  } else {
    dge <- edgeR::estimateDisp(dge)
  }
  et <- edgeR::exactTest(dge, pair = c(control_g, treatment_g))  # logFC = treatment/control
  norm <- as.data.frame(edgeR::cpm(dge, normalized.lib.sizes = TRUE))
  tt <- edgeR::topTags(et, n = Inf, adjust.method = "BH", sort.by = "none")$table
  stats <- data.frame(gene_id = rownames(tt), log2FoldChange = tt$logFC,
                      pvalue = tt$PValue, padj = tt$FDR)
} else if (method == "limma") {
  rgraph_library(c("limma"))
  design <- model.matrix(~0 + grp)
  colnames(design) <- make.names(levels(grp))
  v <- limma::voom(as.matrix(mat), design)
  norm <- as.data.frame(2^v$E)
  fit <- limma::lmFit(v, design)
  ct <- limma::makeContrasts(contrasts = paste0(make.names(treatment_g), "-", make.names(control_g)),
                             levels = design)   # 修正为 treatment - control（原课程写反）
  fit2 <- limma::eBayes(limma::contrasts.fit(fit, ct))
  tt <- limma::topTable(fit2, number = Inf)
  stats <- data.frame(gene_id = rownames(tt), log2FoldChange = tt$logFC,
                      pvalue = tt$P.Value, padj = tt$adj.P.Val)
} else {
  stop(paste0("未知 method: ", method))
}

norm <- data.frame(gene_id = rownames(norm), norm, row.names = NULL, check.names = FALSE)
result <- merge(norm, stats, by = "gene_id", all = TRUE)

# ---- 过滤低表达 + 去 NA ----------------------------------------------------
ns <- length(sg$sample_name); sc <- 2:(ns + 1)
result <- result[rowSums(result[, sc] == 0) < ns * 0.5, ]
result <- result[rowMeans(result[, sc]) >= min_mean, ]
result <- result[!is.na(result$pvalue) & !is.na(result$padj), ]

# ---- DEG 判定（默认 padj，可切 pvalue）-------------------------------------
metric <- result[[sig_metric]]
deg_all  <- result[metric < pcut & abs(result$log2FoldChange) > log2fc, ]
deg_up   <- deg_all[deg_all$log2FoldChange >  log2fc, ]
deg_down <- deg_all[deg_all$log2FoldChange < -log2fc, ]

rgraph_write_csv(result,  p$outdir, "01.Dse2_result")
rgraph_write_csv(deg_all, p$outdir, "02.Deg_all")
rgraph_write_csv(deg_down, p$outdir, "03.Deg_down")
rgraph_write_csv(deg_up,  p$outdir, "04.Deg_up")
cat("RGRAPH_DONE: diff", method, "| treatment=", treatment_g, "control=", control_g,
    "| all=", nrow(result), "DEG=", nrow(deg_all), "up=", nrow(deg_up),
    "down=", nrow(deg_down), "\n")
