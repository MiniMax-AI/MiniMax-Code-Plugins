# network.R —— ggNetView 网络图（相关/共表达/宏基因组共现网络，按模块着色）
# 两种输入模式：
#   mode="matrix": expr(gene_id/OTU + 样本列) → build_graph_from_mat 构相关网络
#                  (method: WGCNA/cor/SPARCC/SpiecEasi/Hmisc)；适合共表达/宏基因组共现
#   mode="edge":   edges(前两列 from,to [+ weight]) [+ nodes(首列=id,附注释)]
#                  → build_graph_from_node_edge；可直接吃 rgraph_wgcna 的 Cytoscape 边表、rgraph_ppi 的 Target_PPi
# params(通用): mode, outdir, name, layout("gephi"), layout_module("random"),
#   group_by("Modularity"), fill_by("Modularity"), color_by, label(F 或前缀字串),
#   pointlabel(如 "top5"), jitter(F), add_outer(F), dpi(300), width(9),height(8)
# params(matrix): expr, sample_group(可选), genes(可选子集), method("WGCNA"), cor_method("pearson"),
#   r_threshold(0.7), p_threshold(0.05), transform("none"), node_annotation(CSV,首列=id), max_features(500)
# params(edge): edges, nodes(可选), from_col, to_col, weight_col, directed(F)
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("ggNetView", "ggplot2", "dplyr"))

mode <- rgraph_opt(p, "mode", "matrix")

if (mode == "edge") {
  edges <- read.csv(p$edges, header = TRUE, check.names = FALSE, stringsAsFactors = FALSE,
                    sep = rgraph_opt(p, "sep", ","))
  if (ncol(edges) < 2) {
    # 容错：可能是制表符/空格分隔
    edges <- read.table(p$edges, header = TRUE, check.names = FALSE, stringsAsFactors = FALSE)
  }
  fc <- rgraph_opt(p, "from_col", names(edges)[1])
  tc <- rgraph_opt(p, "to_col", names(edges)[2])
  wc <- rgraph_opt(p, "weight_col", { wi <- which(tolower(names(edges)) == "weight"); if (length(wi)) names(edges)[wi[1]] else NA })
  edge_df <- data.frame(from = as.character(edges[[fc]]), to = as.character(edges[[tc]]),
                        stringsAsFactors = FALSE)
  if (!is.na(wc) && wc %in% names(edges)) edge_df$weight <- as.numeric(edges[[wc]])
  if (!is.null(p$nodes)) {
    node_df <- read.csv(p$nodes, header = TRUE, check.names = FALSE, stringsAsFactors = FALSE)
  } else {
    node_df <- data.frame(name = unique(c(edge_df$from, edge_df$to)), stringsAsFactors = FALSE)
  }
  obj <- build_graph_from_node_edge(node = node_df, edge = edge_df,
                                    directed = isTRUE(rgraph_opt(p, "directed", FALSE)),
                                    top_modules = rgraph_opt(p, "top_modules", 15))
} else {
  expr <- rgraph_read_matrix(p$expr)
  if (!is.null(p$sample_group)) {
    sg <- rgraph_read_sample_group(p$sample_group); samples <- sg$sample_name
  } else {
    samples <- setdiff(names(expr), c("gene_id", "Length"))
  }
  if (!is.null(p$genes)) expr <- expr[expr$gene_id %in% p$genes, , drop = FALSE]
  rownames(expr) <- expr$gene_id
  mat <- as.matrix(expr[, samples, drop = FALSE]); mode(mat) <- "numeric"
  mat[!is.finite(mat)] <- 0
  # 无基因子集时按方差取 top max_features，控制网络规模/耗时/可读性
  if (is.null(p$genes)) {
    mf <- rgraph_opt(p, "max_features", 500)
    if (nrow(mat) > mf) mat <- mat[order(apply(mat, 1, var), decreasing = TRUE)[seq_len(mf)], , drop = FALSE]
  }
  ann <- NULL
  if (!is.null(p$node_annotation)) ann <- read.csv(p$node_annotation, check.names = FALSE, stringsAsFactors = FALSE)
  obj <- build_graph_from_mat(mat = mat,
                              transfrom.method = rgraph_opt(p, "transform", "none"),
                              method = rgraph_opt(p, "method", "WGCNA"),
                              cor.method = rgraph_opt(p, "cor_method", "pearson"),
                              proc = rgraph_opt(p, "proc", "BH"),
                              r.threshold = rgraph_opt(p, "r_threshold", 0.7),
                              p.threshold = rgraph_opt(p, "p_threshold", 0.05),
                              node_annotation = ann,
                              top_modules = rgraph_opt(p, "top_modules", 15))
}

pl <- ggNetView(graph_obj = obj,
                layout = rgraph_opt(p, "layout", "gephi"),
                layout.module = rgraph_opt(p, "layout_module", "random"),
                group.by = rgraph_opt(p, "group_by", "Modularity"),
                fill.by = rgraph_opt(p, "fill_by", "Modularity"),
                color.by = rgraph_opt(p, "color_by", NULL),
                pointsize = rgraph_opt(p, "pointsize", c(1, 6)),
                jitter = isTRUE(rgraph_opt(p, "jitter", FALSE)),
                add_outer = isTRUE(rgraph_opt(p, "add_outer", FALSE)),
                label = rgraph_opt(p, "label", FALSE),
                pointlabel = rgraph_opt(p, "pointlabel", NULL),
                linealpha = rgraph_opt(p, "linealpha", 0.2),
                linecolor = rgraph_opt(p, "linecolor", "#d9d9d9"))

rgraph_save(pl, p$outdir, rgraph_opt(p, "name", "network"),
            width = rgraph_opt(p, "width", 9), height = rgraph_opt(p, "height", 8),
            dpi = rgraph_opt(p, "dpi", 300))
cat("RGRAPH_DONE: network mode=", mode, "\n")
