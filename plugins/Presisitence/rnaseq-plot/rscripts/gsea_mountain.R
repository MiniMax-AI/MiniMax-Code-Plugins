# gsea_mountain.R —— GSEA 山峦图（多通路 core_enrichment 基因的 log2FC 分布 + NES 点）
# params: gsea_result(gsea.R 产出的 CSV, 含 ID,Description,NES,pvalue,core_enrichment),
#         result(Dse2_result.csv, 取 gene log2FC), outdir,
#         geneset_ids(可选,要画的通路 ID 向量; 缺省取 pvalue 最小的前 n_top 个),
#         n_top(15), dpi(300), width(15),height(13), name
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("dplyr", "tidyr", "ggplot2", "ggridges", "ggnewscale"))

deg <- read.csv(p$result, check.names = FALSE)
gene_rank <- setNames(deg$log2FoldChange, deg$gene_id)

gr <- read.csv(p$gsea_result, stringsAsFactors = FALSE, check.names = FALSE)
if (!is.null(p$geneset_ids)) {
  gr <- gr[gr$ID %in% p$geneset_ids, ]
} else {
  gr <- gr[order(gr$pvalue), ]
  gr <- utils::head(gr, rgraph_opt(p, "n_top", 15))
}
if (nrow(gr) == 0) stop("没有可用于山峦图的通路")

df <- gr %>%
  dplyr::select(Description, NES, pvalue, core_enrichment) %>%
  tidyr::separate_rows(core_enrichment, sep = "/") %>%
  dplyr::mutate(log2FoldChange = gene_rank[core_enrichment],
                neg_log10_pvalue = -log10(pvalue)) %>%
  dplyr::filter(!is.na(log2FoldChange))

min_fc <- min(df$log2FoldChange) - 1
pl <- ggplot2::ggplot(df) +
  ggridges::geom_density_ridges(ggplot2::aes(x = log2FoldChange, y = Description,
                                             fill = neg_log10_pvalue), scale = 0.9) +
  ggplot2::scale_fill_gradient(low = "#e6e2f9", high = "#998ec3", name = "-log10(pvalue)") +
  ggnewscale::new_scale_fill() +
  ggplot2::geom_point(ggplot2::aes(x = min_fc, y = Description, size = abs(NES), fill = NES),
                      shape = 21) +
  ggplot2::scale_fill_gradient2(low = "#4575b4", mid = "#f7f7f7", high = "#d73027", name = "NES") +
  ggplot2::scale_size(range = c(5, 10), guide = "none") +
  theme_rgraph() +
  ggplot2::labs(x = "log2FoldChange", y = NULL)

rgraph_save(pl, p$outdir, rgraph_opt(p, "name", "Mountain_plot"),
            width = rgraph_opt(p, "width", 15), height = rgraph_opt(p, "height", 13),
            dpi = rgraph_opt(p, "dpi", 300))
cat("RGRAPH_DONE: gsea_mountain genesets=", nrow(gr), "\n")
