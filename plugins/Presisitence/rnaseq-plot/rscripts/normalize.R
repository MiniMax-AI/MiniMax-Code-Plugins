# normalize.R —— 由 count 计算 FPKM 或 TPM
# params: count(gene_count.csv 路径), sample_group(路径,可选), outdir,
#         method("fpkm"|"tpm"), out_name(默认 gene_fpkm / gene_tpm)
# 输入列: gene_id, Length, <各样本 count 列>
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])          # _common.R
p <- rgraph_load_params()   # 读取 .args[[1]] 指向的参数文件
rgraph_library(c("dplyr"))

method <- rgraph_opt(p, "method", "fpkm")
gene_count <- rgraph_read_matrix(p$count)
if (!"Length" %in% names(gene_count)) stop("gene_count 缺少 Length 列 (基因长度)，无法计算 FPKM/TPM")

# 样本列：优先按 sample_group，否则用除 gene_id/Length 外的所有数值列
if (!is.null(p$sample_group)) {
  sg <- rgraph_read_sample_group(p$sample_group)
  sample_list <- sg$sample_name
  rgraph_check_samples(gene_count, sample_list)
} else {
  sample_list <- setdiff(names(gene_count), c("gene_id", "Length"))
}

out <- gene_count[, "gene_id", drop = FALSE]
for (s in sample_list) {
  x <- gene_count[[s]]
  x[is.na(x)] <- 0
  if (identical(method, "tpm")) {
    rpk <- x / gene_count$Length
    out[[s]] <- rpk / sum(rpk, na.rm = TRUE) * 1e6
  } else {
    out[[s]] <- (x * 1e9) / gene_count$Length / sum(x, na.rm = TRUE)
  }
}

out_name <- rgraph_opt(p, "out_name", if (identical(method, "tpm")) "gene_tpm" else "gene_fpkm")
rgraph_write_csv(out, p$outdir, out_name)
cat("RGRAPH_DONE: normalize", method, "genes=", nrow(out), "samples=", length(sample_list), "\n")
