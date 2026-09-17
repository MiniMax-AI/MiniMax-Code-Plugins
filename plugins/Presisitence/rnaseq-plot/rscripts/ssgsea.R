# ssgsea.R —— ssGSEA 单样本基因集富集打分 + 各基因集分组箱线图
# params: expr(gene_expression.csv: gene_id+各样本), gmt(geneset.gmt), sample_group, outdir,
#         normalize(bool,默认T), dpi(300)
# 需 GSVA + GSEABase（本机默认缺，按提示 BiocManager::install(c("GSVA","GSEABase"))）
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("GSVA", "GSEABase", "dplyr", "ggplot2"))

sg <- rgraph_read_sample_group(p$sample_group)
expr <- rgraph_read_matrix(p$expr)
expr <- expr[, c("gene_id", sg$sample_name), drop = FALSE]
ns <- length(sg$sample_name)
keep <- rowSums(expr[, -1, drop = FALSE] > 0) / ns >= 0.5 &
        rowMeans(expr[, -1, drop = FALSE]) >= 1
expr <- expr[keep, , drop = FALSE]
rownames(expr) <- expr$gene_id; expr$gene_id <- NULL
mat <- as.matrix(expr)

gs <- GSEABase::getGmt(p$gmt, geneIdType = GSEABase::SymbolIdentifier())
param <- GSVA::ssgseaParam(exprData = mat, geneSets = gs,
                           normalize = isTRUE(rgraph_opt(p, "normalize", TRUE)))
score <- GSVA::gsva(param, verbose = FALSE)
rgraph_write_csv(data.frame(geneset = rownames(score), score, check.names = FALSE),
                 p$outdir, "ssGSEA_score", row.names = FALSE)

cols <- rgraph_palette(length(unique(sg$group_name)), rgraph_opt(p, "palette", "course"))
for (g in rownames(score)) {
  df <- data.frame(Score = as.numeric(score[g, ]), sample_name = colnames(score))
  df$group_name <- factor(sg$group_name[match(df$sample_name, sg$sample_name)],
                          levels = unique(sg$group_name))
  pl <- ggplot2::ggplot(df, ggplot2::aes(x = group_name, y = Score, fill = group_name, colour = group_name)) +
    ggplot2::geom_boxplot(alpha = 0.5, linewidth = 0.6, width = 0.7, outlier.alpha = 0) +
    ggplot2::scale_fill_manual(values = cols) + ggplot2::scale_color_manual(values = cols) +
    ggplot2::labs(title = g, x = NULL, y = "ssGSEA Score") + theme_rgraph() +
    ggplot2::theme(axis.text.x = ggplot2::element_text(angle = 45, hjust = 1))
  rgraph_save(pl, p$outdir, paste0(gsub("[^A-Za-z0-9_.-]", "_", g), "_box"),
              width = 6, height = 6, dpi = rgraph_opt(p, "dpi", 300))
}
cat("RGRAPH_DONE: ssgsea genesets=", nrow(score), "samples=", ncol(score), "\n")
