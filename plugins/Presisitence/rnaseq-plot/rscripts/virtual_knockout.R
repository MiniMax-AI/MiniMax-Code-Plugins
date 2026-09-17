# virtual_knockout.R —— bulk RNA 虚拟敲除（GENIE3 调控网络 + bulkKnk 扰动 + 双轴火山图）
# 输入: count(gene_count.csv), sample_group(需 group_name, pheno_data)
# params: count, sample_group, outdir, ko_gene(敲除基因), ko_group(敲除样本所在分组),
#         logfc(0.5), hv_num(高变基因数,5000), dpi(300)
# 依赖: bulkKnk(课程作者本地源码包, install.packages("bulkKnk-main", repos=NULL, type="source"))
#       + GENIE3(Bioconductor)。二者缺失将返回缺包提示。
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("bulkKnk", "GENIE3", "ggplot2", "dplyr"))
use_repel <- requireNamespace("ggrepel", quietly = TRUE)

ko_gene <- p$ko_gene; ko_group <- p$ko_group
logfc <- rgraph_opt(p, "logfc", 0.5)
hv_num <- rgraph_opt(p, "hv_num", 5000)

sg <- read.csv(p$sample_group, check.names = FALSE, stringsAsFactors = FALSE)
expr <- read.csv(p$count, check.names = FALSE, stringsAsFactors = FALSE)
if (length(unique(expr$gene_id)) < nrow(expr)) stop("gene_id 存在重复，请先去重")
rownames(expr) <- expr$gene_id
mat <- t(expr[, sg$sample_name])

# 高变基因 + 确保 ko_gene 在内
sub_expr <- bulkKnk::select_advanced_features(mat, n_features = hv_num)
genes <- unique(colnames(sub_expr))
if (!(ko_gene %in% genes)) sub_expr <- mat[, c(genes, ko_gene)]
sub_expr <- as.matrix(sub_expr); mode(sub_expr) <- "numeric"

# WGCNA 找相关模块 → 调控网络（GENIE3）→ DPI 剪枝
wg <- bulkKnk::identify_hub_modules(sub_expr, trait_vec = sg$pheno_data)
best <- unique(wg$best_genes); if (!(ko_gene %in% best)) best <- c(best, ko_gene)
focus <- as.matrix(sub_expr[, best])
netc <- bulkKnk::prune_network_dpi_fast(bulkKnk::infer_causal_network(focus)$clean_matrix)
W <- sweep(t(netc), 2, colSums(t(netc)) + 1e-9, FUN = "/")

pheno <- setNames(sg$group_name, sg$sample_name)
common <- intersect(rownames(focus), names(pheno))
ko <- bulkKnk::batch_virtual_knockout(expr_matrix = focus[common, ], adj_matrix = W,
        target_genes = ko_gene, target_pheno = ko_group, pheno_vec = pheno[common])

# 汇总
gs <- data.frame(gene_id = colnames(ko$WT),
                 WT_Mean = colMeans(ko$WT, na.rm = TRUE), KO_Mean = colMeans(ko$KO, na.rm = TRUE))
gs$Diff <- gs$KO_Mean - gs$WT_Mean
gs$log2FoldChange <- log2((gs$KO_Mean + 1e-9) / (gs$WT_Mean + 1e-9))
rgraph_write_csv(gs, p$outdir, "1.virtual_knockout_summary")
sig <- gs[abs(gs$log2FoldChange) > logfc & gs$gene_id != ko_gene, ]
rgraph_write_csv(sig, p$outdir, "2.significant_perturbed_genes")

# 双轴火山图（x=虚拟 log2FC, y=WT 基线表达）
gs$color <- ifelse(gs$log2FoldChange > logfc, "Up regulated",
             ifelse(gs$log2FoldChange < -logfc, "Down regulated", "Stable"))
gs$color[gs$gene_id == ko_gene] <- "KO gene"
cmap <- c("KO gene" = "#2ca02c", "Up regulated" = "#c0392b", "Down regulated" = "#2a80b9", "Stable" = "grey80")
pl <- ggplot2::ggplot(gs, ggplot2::aes(x = log2FoldChange, y = WT_Mean, color = color)) +
  ggplot2::geom_point(alpha = 0.7, size = 1) +
  ggplot2::scale_color_manual(values = cmap, breaks = names(cmap)) +
  ggplot2::geom_vline(xintercept = c(-logfc, logfc), linetype = "dashed", color = "grey") +
  ggplot2::labs(title = "Virtual Knockout Effect", x = "Virtual Log2FC (KO vs WT)",
                y = "Baseline Expression (WT)", color = NULL) +
  theme_rgraph() +
  ggplot2::guides(color = ggplot2::guide_legend(override.aes = list(size = 3)))
lab <- gs[gs$gene_id == ko_gene, ]
if (use_repel && nrow(lab) > 0)
  pl <- pl + ggrepel::geom_label_repel(data = lab, ggplot2::aes(label = gene_id), color = "black",
                                       size = 3, min.segment.length = 0, max.overlaps = Inf)
rgraph_save(pl, p$outdir, rgraph_opt(p, "name", "dual_volcano"),
            width = 7, height = 5, dpi = rgraph_opt(p, "dpi", 300))
cat("RGRAPH_DONE: virtual_knockout ko=", ko_gene, "perturbed=", nrow(sig), "\n")
