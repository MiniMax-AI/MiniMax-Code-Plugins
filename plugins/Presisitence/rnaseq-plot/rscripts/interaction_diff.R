# interaction_diff.R —— 两因子交互作用差异分析（DESeq2 ~g1+g2+g1:g2，提取交互项）
# 输入: count, sample_group(需 group_name1,group_name2,TvsC1,TvsC2)
# params: count, sample_group, outdir, sig_metric("padj"|"pvalue"), pcut(0.05), log2fc(1),
#         min_mean_count(2)
# 输出: 01.DEseq2_result.csv + 02/03/04 Deg_all/down/up（可直接喂 rgraph_volcano）
# 注: 需 DESeq2（本机默认缺，按提示安装）。
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("dplyr", "DESeq2"))

sig_metric <- rgraph_opt(p, "sig_metric", "padj")
pcut <- rgraph_opt(p, "pcut", 0.05)
log2fc <- rgraph_opt(p, "log2fc", 1)
min_mean <- rgraph_opt(p, "min_mean_count", 2)

count <- rgraph_read_matrix(p$count)
sg <- read.csv(p$sample_group, header = TRUE, check.names = FALSE, stringsAsFactors = FALSE)
sg <- sg[!is.na(sg$sample_name) & sg$sample_name != "", , drop = FALSE]
for (col in c("group_name1", "group_name2", "TvsC1", "TvsC2"))
  if (!col %in% names(sg)) stop(paste0("sample_group 缺少列: ", col, "（两因子交互需要）"))
rgraph_check_samples(count, sg$sample_name)

t1 <- unique(sg$group_name1[sg$TvsC1 == "treatment"]); c1 <- unique(sg$group_name1[sg$TvsC1 == "control"])
t2 <- unique(sg$group_name2[sg$TvsC2 == "treatment"]); c2 <- unique(sg$group_name2[sg$TvsC2 == "control"])

mat <- count[, c("gene_id", sg$sample_name)]
rownames(mat) <- mat$gene_id; mat$gene_id <- NULL; mat[is.na(mat)] <- 0
cd <- data.frame(row.names = sg$sample_name,
                 g1 = factor(sg$group_name1, levels = c(c1, t1)),
                 g2 = factor(sg$group_name2, levels = c(c2, t2)))
dds <- DESeq2::DESeqDataSetFromMatrix(round(as.matrix(mat)), cd, design = ~ g1 + g2 + g1:g2)
dds <- DESeq2::DESeq(dds)
norm <- DESeq2::counts(dds, normalized = TRUE)
norm <- data.frame(gene_id = rownames(norm), norm, row.names = NULL, check.names = FALSE)

# 自动定位交互项系数（形如 g1XXX.g2YYY）
inter <- grep("g1.*g2", DESeq2::resultsNames(dds), value = TRUE)
if (length(inter) == 0) stop("未找到交互项系数，请检查分组设计")
res <- as.data.frame(DESeq2::results(dds, name = inter[length(inter)]))
res <- data.frame(gene_id = rownames(res), res[, c("log2FoldChange", "pvalue", "padj")], row.names = NULL)
result <- merge(norm, res, by = "gene_id", all = TRUE)

ns <- length(sg$sample_name); sc <- 2:(ns + 1)
result <- result[rowSums(result[, sc] == 0) < ns * 0.5, ]
result <- result[rowMeans(result[, sc]) >= min_mean, ]
result <- result[!is.na(result$pvalue) & !is.na(result$padj), ]
metric <- result[[sig_metric]]
deg_all <- result[metric < pcut & abs(result$log2FoldChange) > log2fc, ]

rgraph_write_csv(result, p$outdir, "01.DEseq2_result")
rgraph_write_csv(deg_all, p$outdir, "02.Deg_all")
rgraph_write_csv(deg_all[deg_all$log2FoldChange < -log2fc, ], p$outdir, "03.Deg_down")
rgraph_write_csv(deg_all[deg_all$log2FoldChange > log2fc, ], p$outdir, "04.Deg_up")
cat("RGRAPH_DONE: interaction_diff term=", inter[length(inter)], "DEG=", nrow(deg_all), "\n")
