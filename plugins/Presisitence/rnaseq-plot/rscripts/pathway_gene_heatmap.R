# pathway_gene_heatmap.R —— 通路富集基因的相关性热图 / 聚类热图（逐通路出图）
# 输入: enrich(GO/KEGG 富集表, 需 Description 及基因列 geneID/Gene_symbol), fpkm, sample_group
# params: enrich, fpkm, sample_group, outdir, kind("correlation"|"cluster"),
#         id_col(富集表里与 fpkm gene_id 同类型的基因列, 默认 geneID),
#         min_count(通路基因数下限,默认3), max_pathways(最多出图通路数,默认6),
#         pathway_col(通路命名列, 默认 GOID/KEGGID/Description), dpi(300)
# 注: id_col 的基因需与 fpkm 的 gene_id 同一 ID 类型（本流程 rgraph_enrich→rgraph_diff 天然一致）。
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("dplyr", "tidyr", "ggplot2", "reshape2"))

kind <- rgraph_opt(p, "kind", "correlation")
id_col <- rgraph_opt(p, "id_col", "geneID")
et <- read.csv(p$enrich, stringsAsFactors = FALSE, check.names = FALSE)
fpkm <- rgraph_read_matrix(p$fpkm)
sg <- rgraph_read_sample_group(p$sample_group)
if (!id_col %in% names(et)) stop(paste0("富集表缺少基因列: ", id_col))

# 通路命名列
pcol <- rgraph_opt(p, "pathway_col",
                   intersect(c("GOID", "KEGGID", "Description"), names(et))[1])
et <- et[et$Count >= rgraph_opt(p, "min_count", 3), , drop = FALSE]
et <- et[order(-et$Count), , drop = FALSE]
et <- utils::head(et, rgraph_opt(p, "max_pathways", 6))

sel_fpkm <- fpkm[, c("gene_id", sg$sample_name), drop = FALSE]
n_ok <- 0
for (i in seq_len(nrow(et))) {
  pid <- gsub("[^A-Za-z0-9_.-]", "_", as.character(et[[pcol]][i]))
  genes <- unique(trimws(strsplit(as.character(et[[id_col]][i]), "/")[[1]]))
  sub <- sel_fpkm[sel_fpkm$gene_id %in% genes, , drop = FALSE]
  if (nrow(sub) < 2) next
  rownames(sub) <- sub$gene_id; sub$gene_id <- NULL
  m <- as.matrix(sub); m[is.na(m)] <- 0
  logm <- log2(m + 1)
  logm <- logm[rowSums(logm) != 0, , drop = FALSE]
  if (nrow(logm) < 2) next

  if (kind == "cluster") {
    rgraph_library(c("pheatmap"))
    pal <- grDevices::colorRampPalette(c("blue", "white", "red"))(100)
    for (fmt in c("png", "pdf")) {
      f <- file.path(p$outdir, paste0(pid, ".", fmt))
      rgraph_ensure_dir(p$outdir)
      pheatmap::pheatmap(logm, scale = "row", cluster_rows = TRUE, cluster_cols = TRUE,
                         color = pal, border_color = "grey80", show_rownames = nrow(logm) <= 60,
                         fontsize_col = 10, angle_col = 45,
                         width = 8, height = max(4, nrow(logm) * 0.2 + 2), filename = f)
      rgraph_emit(f)
    }
  } else {
    cm <- cor(t(logm), use = "pairwise.complete.obs")
    df <- reshape2::melt(cm); df$size <- abs(df$value)
    pl <- ggplot2::ggplot(df, ggplot2::aes(x = Var2, y = Var1, fill = value)) +
      ggplot2::geom_tile(color = "white", linewidth = 0.4) +
      ggplot2::geom_text(ggplot2::aes(label = round(value, 2)), size = 2.6) +
      ggplot2::scale_fill_gradientn(colors = grDevices::colorRampPalette(c("#f3ec98", "#f7440e"))(100),
                                    name = expression(R^2)) +
      ggplot2::labs(x = NULL, y = NULL, title = as.character(et[[pcol]][i])) +
      theme_rgraph() +
      ggplot2::theme(axis.text.x = ggplot2::element_text(angle = 45, hjust = 1)) +
      ggplot2::coord_fixed()
    sz <- max(5, nrow(logm) * 0.5)
    rgraph_save(pl, p$outdir, pid, width = sz, height = sz, dpi = rgraph_opt(p, "dpi", 300))
  }
  n_ok <- n_ok + 1
}
if (n_ok == 0) stop("无通路满足条件（可能 id_col 基因与 fpkm 的 gene_id 类型不一致）")
cat("RGRAPH_DONE: pathway_gene_heatmap", kind, "pathways=", n_ok, "\n")
