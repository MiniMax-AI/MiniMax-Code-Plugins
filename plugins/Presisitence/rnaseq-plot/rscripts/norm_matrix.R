# norm_matrix.R —— 表达矩阵标准化（DESeq2 中位数比值 / limma voom logCPM）
# params: count(gene_count.csv), sample_group, outdir, method("deseq2"|"limma"),
#         min_mean(limma 低表达过滤, 默认1), name(默认 normalized_count)
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("dplyr"))

method <- rgraph_opt(p, "method", "deseq2")
count <- rgraph_read_matrix(p$count)
sg <- rgraph_read_sample_group(p$sample_group)
rgraph_check_samples(count, sg$sample_name)

mat <- count[, c("gene_id", sg$sample_name)]
rownames(mat) <- mat$gene_id; mat$gene_id <- NULL
mat[is.na(mat)] <- 0
grp <- factor(sg$group[match(colnames(mat), sg$sample_name)])

if (method == "limma") {
  rgraph_library(c("limma"))
  ns <- length(sg$sample_name)
  keep <- rowSums(mat == 0) < ns * 0.5 & rowMeans(mat) >= rgraph_opt(p, "min_mean", 1)
  mat <- mat[keep, , drop = FALSE]
  design <- model.matrix(~0 + grp)
  v <- limma::voom(as.matrix(mat), design)
  norm <- 2^v$E
} else {
  rgraph_library(c("DESeq2"))
  coldata <- data.frame(row.names = colnames(mat), group = grp)
  dds <- DESeq2::DESeqDataSetFromMatrix(round(as.matrix(mat)), coldata, design = ~group)
  dds <- DESeq2::estimateSizeFactors(dds)
  norm <- DESeq2::counts(dds, normalized = TRUE)
}
out <- data.frame(gene_id = rownames(norm), norm, row.names = NULL, check.names = FALSE)
rgraph_write_csv(out, p$outdir, rgraph_opt(p, "name", "normalized_count"))
cat("RGRAPH_DONE: norm_matrix", method, "genes=", nrow(out), "\n")
