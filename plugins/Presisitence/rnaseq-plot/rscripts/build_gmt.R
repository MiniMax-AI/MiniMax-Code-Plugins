# build_gmt.R —— 为 GSEA 构建 gmt 基因集
# params: outdir, type("go"|"kegg"), orgdb(如 org.Hs.eg.db / 自建 org.Xxx.eg.db),
#         source("orgdb"|"online"), keytype("GID"|"ENSEMBL"), kegg_species("hsa"),
#         min_count(5), name(默认 GSEA_GO / GSEA_KEGG)
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("dplyr", "tidyr", "stringr", "AnnotationDbi", p$orgdb))
odb <- get(p$orgdb)

type <- rgraph_opt(p, "type", "go")
min_count <- rgraph_opt(p, "min_count", 5)
keytype <- rgraph_opt(p, "keytype", "GID")

to_gmt <- function(df, term_col, gene_col) {
  df <- na.omit(df[, c(term_col, gene_col)])
  names(df) <- c("term", "gene")
  df$term <- gsub(":", "_", df$term)
  df <- df %>% add_count(term, name = "n") %>% filter(n > min_count) %>% dplyr::select(term, gene)
  wide <- df %>% group_by(term) %>% mutate(row = row_number()) %>%
    tidyr::pivot_wider(names_from = row, values_from = gene) %>% ungroup()
  wide <- wide %>% mutate(desc = "-", .after = 1)
  wide
}

if (type == "go") {
  g <- AnnotationDbi::select(odb, keys = AnnotationDbi::keys(odb, keytype = keytype),
                             keytype = keytype, columns = c("GO"))
  gcol <- intersect(c(keytype, "GID", "ENSEMBL"), names(g))[1]
  wide <- to_gmt(g, "GO", gcol)
  nm <- rgraph_opt(p, "name", "GSEA_GO")
} else {
  if (rgraph_opt(p, "source", "orgdb") == "online") {
    sp <- rgraph_opt(p, "kegg_species", "hsa")
    options(timeout = 600)
    pe <- read.delim(sprintf("https://rest.kegg.jp/link/pathway/%s", sp), sep = "\t",
                     col.names = c("ENTREZID", "KEGGID"))
    pe$ENTREZID <- str_remove(pe$ENTREZID, paste0(sp, ":"))
    pe$KEGGID <- str_remove(pe$KEGGID, "path:")
    map <- AnnotationDbi::select(odb, keys = AnnotationDbi::keys(odb, keytype = "ENTREZID"),
                                 keytype = "ENTREZID", columns = c("ENSEMBL"))
    pe <- merge(pe, na.omit(map), by = "ENTREZID")
    wide <- to_gmt(pe, "KEGGID", "ENSEMBL")
  } else {
    g <- AnnotationDbi::select(odb, keys = AnnotationDbi::keys(odb, keytype = keytype),
                               keytype = keytype, columns = c("Pathway"))
    gcol <- intersect(c(keytype, "GID"), names(g))[1]
    wide <- to_gmt(g, "Pathway", gcol)
  }
  nm <- rgraph_opt(p, "name", "GSEA_KEGG")
}

rgraph_ensure_dir(p$outdir)
f <- file.path(p$outdir, paste0(nm, ".gmt"))
write.table(wide, f, col.names = FALSE, row.names = FALSE, sep = "\t", quote = FALSE, na = "")
rgraph_emit(f)
cat("RGRAPH_DONE: build_gmt", type, "genesets=", nrow(wide), "\n")
