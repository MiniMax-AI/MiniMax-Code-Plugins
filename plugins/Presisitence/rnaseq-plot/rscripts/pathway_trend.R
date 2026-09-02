# pathway_trend.R —— 通路上下调基因统计图（发散条形/堆叠条形）
# 输入: enrich(富集表, 需 Description 与 geneID["a/b/c"]), deg(Dse2_result, 需 gene_id,log2FoldChange)
# params: enrich, deg, outdir, kind("diverge"|"stack"), top_n(默认全部), dpi(300), width(10),height(8), name
# 说明: 默认 enrich 的 geneID 与 deg 的 gene_id 为同一 ID 类型(直接匹配)。
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("dplyr", "tidyr", "ggplot2"))

kind <- rgraph_opt(p, "kind", "diverge")
et <- read.csv(p$enrich, stringsAsFactors = FALSE, check.names = FALSE)
deg <- read.csv(p$deg, stringsAsFactors = FALSE, check.names = FALSE)
if (!"geneID" %in% names(et)) stop("富集表缺少 geneID 列")

pg <- et %>% dplyr::rowwise() %>%
  dplyr::mutate(gene_id = strsplit(as.character(geneID), "/")) %>%
  tidyr::unnest(gene_id) %>% dplyr::ungroup() %>%
  dplyr::select(Description, gene_id) %>% dplyr::distinct()
pg <- merge(pg, deg[, c("gene_id", "log2FoldChange")], by = "gene_id")
pg$Trend <- ifelse(pg$log2FoldChange > 0, "Up", "Down")

stat <- pg %>% dplyr::group_by(Description, Trend) %>%
  dplyr::summarise(Count = dplyr::n(), .groups = "drop") %>%
  tidyr::pivot_wider(names_from = Trend, values_from = Count, values_fill = list(Count = 0))
if (!"Up" %in% names(stat)) stat$Up <- 0
if (!"Down" %in% names(stat)) stat$Down <- 0

# top_n 通路（按总数）
if (!is.null(p$top_n)) {
  stat <- stat %>% dplyr::mutate(tot = Up + Down) %>% dplyr::arrange(dplyr::desc(tot)) %>%
    dplyr::slice(seq_len(min(p$top_n, dplyr::n()))) %>% dplyr::select(-tot)
}

if (kind == "stack") {
  long <- stat %>% tidyr::pivot_longer(cols = c(Down, Up), names_to = "Trend", values_to = "Count")
  pl <- ggplot2::ggplot(long, ggplot2::aes(x = Description, y = Count, fill = Trend)) +
    ggplot2::geom_col(position = "stack", width = 0.7) +
    ggplot2::geom_text(ggplot2::aes(label = Count), position = ggplot2::position_stack(vjust = 0.5), size = 3) +
    ggplot2::scale_fill_manual(values = c(Down = "#157d9f", Up = "#f4736c")) +
    ggplot2::labs(x = NULL, y = "Number of DEGs") + theme_rgraph() + ggplot2::coord_flip()
} else {
  stat$Down <- -stat$Down
  long <- stat %>% tidyr::pivot_longer(cols = c(Down, Up), names_to = "Trend", values_to = "Count")
  xmax <- max(abs(long$Count))
  pl <- ggplot2::ggplot(long, ggplot2::aes(x = Count, y = Description, fill = Trend)) +
    ggplot2::geom_col() +
    ggplot2::geom_vline(xintercept = 0, lty = 4, lwd = 0.6, alpha = 0.8) +
    ggplot2::scale_fill_manual(values = c(Down = "#157d9f", Up = "#f4736c")) +
    ggplot2::scale_x_continuous(labels = function(x) abs(x), limits = c(-xmax, xmax)) +
    ggplot2::labs(x = "Number of DEGs", y = NULL) + theme_rgraph()
}

rgraph_save(pl, p$outdir, rgraph_opt(p, "name", "pathway_trend"),
            width = rgraph_opt(p, "width", 10), height = rgraph_opt(p, "height", 8),
            dpi = rgraph_opt(p, "dpi", 300))
cat("RGRAPH_DONE: pathway_trend", kind, "pathways=", nrow(stat), "\n")
