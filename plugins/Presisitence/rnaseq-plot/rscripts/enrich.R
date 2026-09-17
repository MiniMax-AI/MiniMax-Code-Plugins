# enrich.R —— GO / KEGG 富集分析（支持模式物种 OrgDb 与非模式物种自建基因集）
# params:
#   gene_list(路径,列 gene_id[,log2FoldChange]), outdir, type("go"|"kegg")
#   orgdb(如 "org.Hs.eg.db"), id_type("ENSEMBL"|"SYMBOL"|"ENTREZID"|"GID")
#   ont("all"|"BP"|"CC"|"MF")            # GO
#   go_source("orgdb"|"custom")          # custom: 从 OrgDb 的 GO 列自建 TERM2GENE(非模式)
#   kegg_source("online"|"gmt"), kegg_species(如 "hsa"), gmt(路径), kegg_info(路径,可选)
#   pAdjustMethod("BH"), pvalueCutoff(1), qvalueCutoff(1)
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("clusterProfiler", "dplyr", "stringr"))

type <- rgraph_opt(p, "type", "go")
padj_m <- rgraph_opt(p, "pAdjustMethod", "BH")
pcut <- rgraph_opt(p, "pvalueCutoff", 1)
qcut <- rgraph_opt(p, "qvalueCutoff", 1)
id_type <- rgraph_opt(p, "id_type", "ENSEMBL")

gl <- read.csv(p$gene_list, stringsAsFactors = FALSE, check.names = FALSE)
genes_in <- gl$gene_id

to_entrez <- function(ids) {
  rgraph_library(c(p$orgdb))
  suppressWarnings(clusterProfiler::bitr(ids, fromType = id_type, toType = "ENTREZID",
                                         OrgDb = p$orgdb))$ENTREZID
}

if (type == "go") {
  go_source <- rgraph_opt(p, "go_source", "orgdb")
  ont <- rgraph_opt(p, "ont", "all")
  if (go_source == "custom") {
    rgraph_library(c(p$orgdb, "AnnotationDbi"))
    odb <- get(p$orgdb)
    g2go <- AnnotationDbi::select(odb, keys = AnnotationDbi::keys(odb), columns = c("GO"))
    g2go <- na.omit(g2go[, c("GO", intersect(c("GID", "ENSEMBL"), names(g2go))[1])])
    names(g2go) <- c("term", "gene")
    er <- clusterProfiler::enricher(genes_in, TERM2GENE = g2go[, c("term", "gene")],
                                    pAdjustMethod = padj_m, pvalueCutoff = pcut, qvalueCutoff = qcut)
    res <- er@result
  } else {
    rgraph_library(c(p$orgdb))
    genes <- if (id_type == "ENTREZID") genes_in else to_entrez(genes_in)
    er <- clusterProfiler::enrichGO(gene = genes, OrgDb = p$orgdb, keyType = "ENTREZID",
                                    ont = ont, pAdjustMethod = padj_m,
                                    pvalueCutoff = pcut, qvalueCutoff = qcut)
    res <- er@result
    names(res)[names(res) == "ID"] <- "GOID"
  }
  names(res)[names(res) == "p.adjust"] <- "padj"
  rgraph_write_csv(res, p$outdir, rgraph_opt(p, "name", "GO_enrich"))
  cat("RGRAPH_DONE: enrich go terms=", nrow(res), "\n")
} else {
  kegg_source <- rgraph_opt(p, "kegg_source", "online")
  if (kegg_source == "gmt") {
    t2g <- clusterProfiler::read.gmt(p$gmt)
    er <- clusterProfiler::enricher(genes_in, TERM2GENE = t2g, pAdjustMethod = padj_m,
                                    pvalueCutoff = pcut, qvalueCutoff = qcut)
    res <- er@result
    names(res)[names(res) == "p.adjust"] <- "padj"
  } else {
    sp <- rgraph_opt(p, "kegg_species", "hsa")
    options(timeout = 600)
    pe <- read.delim(sprintf("https://rest.kegg.jp/link/pathway/%s", sp), sep = "\t",
                     col.names = c("gene", "KEGGID"))
    pe$gene <- str_remove(pe$gene, paste0(sp, ":"))
    pe$KEGGID <- str_remove(pe$KEGGID, "path:")
    t2g <- pe[, c("KEGGID", "gene")]
    genes <- if (id_type == "ENTREZID") genes_in else to_entrez(genes_in)
    er <- clusterProfiler::enricher(genes, TERM2GENE = t2g, pAdjustMethod = padj_m,
                                    pvalueCutoff = pcut, qvalueCutoff = qcut)
    res <- er@result
    names(res)[names(res) == "ID"] <- "KEGGID"
    names(res)[names(res) == "p.adjust"] <- "padj"
    if (!is.null(p$kegg_info)) {
      ki <- read.csv(p$kegg_info, stringsAsFactors = FALSE)
      res <- merge(ki, res, by = "KEGGID", all.y = TRUE)
    }
  }
  rgraph_write_csv(res, p$outdir, rgraph_opt(p, "name", "KEGG_enrich"))
  cat("RGRAPH_DONE: enrich kegg pathways=", nrow(res), "\n")
}
