# sankey.R —— 富集通路-基因 桑基图（用 ggalluvial 重写；基因→通路流向）
# 输入: enrich(富集表, 需 Description/通路名 与 geneID["a/b/c"])
# params: enrich, outdir, id_col(基因列,默认geneID), pathway_col(通路名列,默认Description),
#         top_n(通路数,默认8), dpi(300), width(12),height(8), name
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("dplyr", "tidyr", "ggplot2", "ggalluvial"))

id_col <- rgraph_opt(p, "id_col", "geneID")
pcol <- rgraph_opt(p, "pathway_col", "Description")
et <- read.csv(p$enrich, stringsAsFactors = FALSE, check.names = FALSE)
if (!id_col %in% names(et)) stop(paste0("富集表缺少基因列: ", id_col))
if ("Count" %in% names(et)) et <- et[order(-et$Count), , drop = FALSE]
et <- utils::head(et, rgraph_opt(p, "top_n", 8))

pairs <- et %>% dplyr::rowwise() %>%
  dplyr::mutate(Gene = strsplit(as.character(.data[[id_col]]), "/")) %>%
  tidyr::unnest(Gene) %>% dplyr::ungroup() %>%
  dplyr::transmute(Gene = trimws(Gene), Pathway = .data[[pcol]]) %>%
  dplyr::distinct()
pairs$freq <- 1
pairs$id <- seq_len(nrow(pairs))

long <- ggalluvial::to_lodes_form(pairs, key = "axis", value = "stratum",
                                  axes = c("Gene", "Pathway"), id = "id")
ncol_need <- length(unique(long$stratum))
fill <- rgraph_palette(ncol_need, rgraph_opt(p, "palette", "course"))

pl <- ggplot2::ggplot(long, ggplot2::aes(x = axis, stratum = stratum, alluvium = id, label = stratum)) +
  ggalluvial::geom_flow(ggplot2::aes(fill = stratum), width = 0.3, alpha = 0.5) +
  ggalluvial::geom_stratum(ggplot2::aes(fill = stratum), width = 0.3, color = "grey40") +
  ggplot2::geom_text(stat = ggalluvial::StatStratum, size = 2.6) +
  ggplot2::scale_fill_manual(values = fill, guide = "none") +
  ggplot2::scale_x_discrete(limits = c("Gene", "Pathway"), expand = c(0.1, 0.1)) +
  ggplot2::labs(x = NULL, y = NULL) +
  ggplot2::theme_void() +
  ggplot2::theme(axis.text.x = ggplot2::element_text(face = "bold", size = 12))

rgraph_save(pl, p$outdir, rgraph_opt(p, "name", "sankey"),
            width = rgraph_opt(p, "width", 12), height = rgraph_opt(p, "height", 8),
            dpi = rgraph_opt(p, "dpi", 300))
cat("RGRAPH_DONE: sankey pathways=", nrow(et), "edges=", nrow(pairs), "\n")
