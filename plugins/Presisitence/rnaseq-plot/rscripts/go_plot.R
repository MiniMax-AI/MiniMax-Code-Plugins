# go_plot.R —— GO 富集条形图/气泡图（BP/CC/MF 三面板，纵向拼接）
# 输入: GO_enrich.csv (列: ONTOLOGY, Description, GeneRatio, pvalue, Count)
# params: enrich, outdir, kind("bar"|"dot"), top_n(每类10), desc_len(120),
#         dpi(300), width(11), height(10), name
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("dplyr", "ggplot2", "stringr", "patchwork"))

parse_ratio <- function(x) vapply(x, function(s) {
  s <- as.character(s)
  if (grepl("/", s)) { a <- as.numeric(strsplit(s, "/")[[1]]); a[1] / a[2] } else as.numeric(s)
}, numeric(1))

kind <- rgraph_opt(p, "kind", "bar")
top_n <- rgraph_opt(p, "top_n", 10)
desc_len <- rgraph_opt(p, "desc_len", 120)

d <- read.csv(p$enrich, stringsAsFactors = FALSE, check.names = FALSE)
if (!"ONTOLOGY" %in% names(d)) stop("GO_enrich 缺少 ONTOLOGY 列")
d$neg_log10_pvalue <- -log10(d$pvalue)
d$GeneRatio <- parse_ratio(d$GeneRatio)
d$Description <- substr(d$Description, 1, desc_len)

d <- d %>% dplyr::group_by(ONTOLOGY) %>% dplyr::arrange(pvalue) %>%
  dplyr::slice(seq_len(min(top_n, dplyr::n()))) %>% dplyr::ungroup()

# 三类各自的低/高配色（沿用课程）
pal <- list(BP = c("#f2c7b9", "#e74716"), CC = c("#90dee7", "#0a8a99"), MF = c("#b2eecf", "#41ae76"))
onts <- intersect(c("BP", "CC", "MF"), unique(d$ONTOLOGY))

panel <- function(ont, show_x) {
  dd <- d %>% dplyr::filter(ONTOLOGY == ont) %>%
    dplyr::arrange(if (kind == "dot") desc(GeneRatio) else desc(Count)) %>%
    dplyr::mutate(Description = factor(Description, levels = rev(Description)))
  cols <- pal[[ont]]
  base <- ggplot2::ggplot(dd) +
    ggplot2::facet_grid(ONTOLOGY ~ ., scales = "free_y", space = "free_y") +
    theme_rgraph() +
    ggplot2::theme(strip.text = ggplot2::element_text(face = "bold", size = 12, color = "white"),
                   strip.background = ggplot2::element_rect(fill = cols[2], color = "black"),
                   axis.text.y = ggplot2::element_text(size = 11, color = cols[2]),
                   axis.text.x = if (show_x) ggplot2::element_text(size = 10) else ggplot2::element_blank()) +
    ggplot2::scale_y_discrete(labels = function(y) str_wrap(y, width = 60)) +
    ggplot2::labs(x = if (show_x) (if (kind == "dot") "GeneRatio" else "-log10(pvalue)") else NULL, y = NULL)
  if (kind == "dot") {
    base + ggplot2::geom_point(ggplot2::aes(x = GeneRatio, y = Description,
                                            fill = neg_log10_pvalue, size = Count), shape = 21, colour = cols[2]) +
      ggplot2::scale_fill_gradient(low = cols[1], high = cols[2], name = "-log10(pvalue)") +
      ggplot2::scale_size_continuous(range = c(3, 6), name = "Count")
  } else {
    base + ggplot2::geom_col(ggplot2::aes(x = neg_log10_pvalue, y = Description, fill = Count), width = 0.7) +
      ggplot2::scale_fill_gradient(low = cols[1], high = cols[2], name = "Count")
  }
}

plots <- lapply(seq_along(onts), function(i) panel(onts[i], show_x = (i == length(onts))))
pl <- Reduce(`/`, plots)

rgraph_save(pl, p$outdir, rgraph_opt(p, "name", paste0("GO_", kind)),
            width = rgraph_opt(p, "width", 11), height = rgraph_opt(p, "height", 10),
            dpi = rgraph_opt(p, "dpi", 300))
cat("RGRAPH_DONE: go_plot", kind, "ontologies=", paste(onts, collapse = "/"), "\n")
