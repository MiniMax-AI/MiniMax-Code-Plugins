# ppi.R —— 基于 STRING 的差异基因蛋白互作网络边表
# params: deg(Deg_all.csv, 列 gene_id), info(9606.protein.info.txt),
#         links(9606.protein.links.txt), outdir, score(400),
#         id_is_symbol(bool,默认F), orgdb(id 非 symbol 时用于 ENSEMBL->SYMBOL)
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("dplyr"))

deg <- read.csv(p$deg, stringsAsFactors = FALSE)
info <- read.csv(p$info, sep = "\t", stringsAsFactors = FALSE)
links <- read.csv(p$links, sep = " ", stringsAsFactors = FALSE)

if (isTRUE(rgraph_opt(p, "id_is_symbol", FALSE))) {
  genes <- data.frame(gene_id = unique(deg$gene_id))
} else {
  rgraph_library(c("clusterProfiler", p$orgdb))
  genes <- suppressWarnings(clusterProfiler::bitr(deg$gene_id, fromType = "ENSEMBL",
                                                  toType = "SYMBOL", OrgDb = p$orgdb))
  genes <- data.frame(gene_id = unique(genes$SYMBOL))
}

# symbol -> string_protein_id
genes <- merge(genes, info[, c("string_protein_id", "preferred_name")],
               by.x = "gene_id", by.y = "preferred_name")

dl <- merge(links, genes, by.x = "protein1", by.y = "string_protein_id")
names(dl)[names(dl) == "gene_id"] <- "from_symbol"
dl <- merge(dl, genes, by.x = "protein2", by.y = "string_protein_id")
names(dl)[names(dl) == "gene_id"] <- "to_symbol"
names(dl)[names(dl) == "protein1"] <- "from_protein"
names(dl)[names(dl) == "protein2"] <- "to_protein"

dl <- dl %>%
  dplyr::select(from_protein, to_protein, from_symbol, to_symbol, combined_score) %>%
  dplyr::rowwise() %>%
  dplyr::mutate(a = pmin(from_symbol, to_symbol), b = pmax(from_symbol, to_symbol)) %>%
  dplyr::ungroup() %>%
  dplyr::distinct(a, b, .keep_all = TRUE) %>%
  dplyr::select(-a, -b) %>%
  dplyr::filter(combined_score >= rgraph_opt(p, "score", 400))

rgraph_ensure_dir(p$outdir)
f1 <- file.path(p$outdir, "Target_PPi.tsv")
write.table(dl, f1, row.names = FALSE, sep = "\t"); rgraph_emit(f1)
nodes <- length(unique(c(dl$from_symbol, dl$to_symbol)))
f2 <- file.path(p$outdir, "Edge_Node_count.tsv")
write.table(data.frame(Node_count = nodes, Edge_count = nrow(dl)), f2, row.names = FALSE, sep = "\t")
rgraph_emit(f2)
cat("RGRAPH_DONE: ppi nodes=", nodes, "edges=", nrow(dl), "\n")
