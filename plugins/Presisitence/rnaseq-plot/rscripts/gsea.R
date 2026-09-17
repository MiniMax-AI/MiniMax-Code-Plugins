# gsea.R —— GSEA 分析（基于差异结果 log2FoldChange 排序 + gmt 基因集）
# params: result(Dse2_result.csv), gmt(路径), outdir, minGSSize(5), maxGSSize(1000),
#         pvalueCutoff(1), desc_map(可选 CSV: 列 ID,Description), top_n(每方向出图数,默认5),
#         draw(bool,默认T), seed(123)
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("clusterProfiler", "enrichplot", "ggplot2", "dplyr"))

deg <- read.csv(p$result, check.names = FALSE)
deg <- deg %>% dplyr::select(gene_id, log2FoldChange) %>% dplyr::filter(!is.na(log2FoldChange))
gene_rank <- sort(setNames(deg$log2FoldChange, deg$gene_id), decreasing = TRUE)

t2g <- clusterProfiler::read.gmt(p$gmt)
set.seed(rgraph_opt(p, "seed", 123))
gsea <- clusterProfiler::GSEA(geneList = gene_rank, TERM2GENE = t2g,
                              pvalueCutoff = rgraph_opt(p, "pvalueCutoff", 1),
                              pAdjustMethod = "BH",
                              minGSSize = rgraph_opt(p, "minGSSize", 5),
                              maxGSSize = rgraph_opt(p, "maxGSSize", 1000))
res <- gsea@result

if (!is.null(p$desc_map)) {
  dm <- read.csv(p$desc_map, stringsAsFactors = FALSE)
  if (all(c("ID", "Description") %in% names(dm))) {
    res$Description <- dm$Description[match(res$ID, dm$ID)]
  }
}
rgraph_write_csv(res, p$outdir, rgraph_opt(p, "name", "GSEA_result"))

# ---- 各方向 top-N 通路 ES 图 -----------------------------------------------
if (isTRUE(rgraph_opt(p, "draw", TRUE)) && nrow(res) > 0) {
  top_n <- rgraph_opt(p, "top_n", 5)
  draw_dir <- function(sub, sign_dir) {
    if (nrow(sub) == 0) return(invisible())
    sub <- sub[order(sub$pvalue), ]
    sub <- utils::head(sub, top_n)
    for (id in sub$ID) {
      idx <- which(gsea@result$ID == id)
      ttl <- paste0(res$Description[match(id, res$ID)], " [", id, "]")
      pl <- enrichplot::gseaplot2(gsea, geneSetID = idx, ES_geom = "line", title = ttl)
      rgraph_save(pl, file.path(p$outdir, sign_dir), gsub("[^A-Za-z0-9]", "_", id),
                  width = 8, height = 8, dpi = rgraph_opt(p, "dpi", 300))
    }
  }
  draw_dir(res[res$NES > 0, ], "UP")
  draw_dir(res[res$NES < 0, ], "DOWN")
}
cat("RGRAPH_DONE: gsea genesets=", nrow(res), "\n")
