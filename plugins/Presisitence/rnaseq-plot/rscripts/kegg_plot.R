# kegg_plot.R —— KEGG 富集条形图/气泡图
# 输入: KEGG_enrich.csv (列: Description, GeneRatio, pvalue, Count)
# params: enrich, outdir, kind("bar"|"dot"), top_n(30), dpi(300), width(9),height(7), name
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("dplyr", "ggplot2", "stringr"))

parse_ratio <- function(x) vapply(x, function(s) {
  s <- as.character(s)
  if (grepl("/", s)) { a <- as.numeric(strsplit(s, "/")[[1]]); a[1] / a[2] } else as.numeric(s)
}, numeric(1))

kind <- rgraph_opt(p, "kind", "dot")
top_n <- rgraph_opt(p, "top_n", 30)

d <- read.csv(p$enrich, stringsAsFactors = FALSE, check.names = FALSE)
d$neg_log10_pvalue <- -log10(d$pvalue)
d$GeneRatio <- parse_ratio(d$GeneRatio)
d <- d %>% dplyr::arrange(pvalue) %>% dplyr::slice(seq_len(min(top_n, dplyr::n())))
d$Description <- str_remove(d$Description, "\\(.*")   # 去掉括号后缀
ord <- if (kind == "dot") order(d$neg_log10_pvalue, decreasing = TRUE) else order(d$GeneRatio, decreasing = TRUE)
d$Description <- factor(d$Description, levels = rev(d$Description[ord]))

if (kind == "dot") {
  pl <- ggplot2::ggplot(d) +
    ggplot2::geom_point(ggplot2::aes(x = GeneRatio, y = Description, fill = neg_log10_pvalue,
                                     size = Count), shape = 21, colour = "grey20") +
    ggplot2::scale_fill_gradient(low = "yellow", high = "red", name = "-log10(pvalue)") +
    ggplot2::scale_size(range = c(2, 6), name = "Count") +
    ggplot2::labs(x = "GeneRatio", y = NULL)
} else {
  pl <- ggplot2::ggplot(d) +
    ggplot2::geom_col(ggplot2::aes(x = neg_log10_pvalue, y = Description, fill = GeneRatio)) +
    ggplot2::scale_fill_gradient(low = "yellow", high = "red", name = "GeneRatio") +
    ggplot2::labs(x = "-log10(pvalue)", y = NULL)
}
pl <- pl + theme_rgraph() +
  ggplot2::scale_y_discrete(labels = function(y) str_wrap(y, width = 55))

rgraph_save(pl, p$outdir, rgraph_opt(p, "name", paste0("KEGG_", kind)),
            width = rgraph_opt(p, "width", 9), height = rgraph_opt(p, "height", 7),
            dpi = rgraph_opt(p, "dpi", 300))
cat("RGRAPH_DONE: kegg_plot", kind, "pathways=", nrow(d), "\n")
