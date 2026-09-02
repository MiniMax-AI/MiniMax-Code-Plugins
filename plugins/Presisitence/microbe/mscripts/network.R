# network.R —— 微生物共现网络 (Spearman/Hmisc + igraph 拓扑 + keystone)
#   对齐 Liu2023 Fig1i (Spearman ρ>0.7 & P<0.05, BH校正; 正/负边着色; 点大小=degree)
#   与 Zhou2022 Fig2a-f (网络拓扑: 节点/边/度/平均路径长度/模块度; keystone 驱动菌)
# params: feature_table, metadata(可选,配合 group 只取某组样本), taxonomy(可选,按门着色),
#   outdir, level(可选,如 "Genus" 先汇总), group(可选,只用该组样本建网),
#   method("spearman"|"pearson"，默认 spearman), r_threshold(0.7), p_threshold(0.05),
#   padjust(bool,默认T BH), min_prev(最小检出样本数,默认样本数的1/3), top_n(限最丰 N 类群,默认150),
#   layout("fr"|"circle"，默认 fr), label(bool,默认F 仅标 keystone), dpi,width,height,name
# 输出: network_edges.csv, network_nodes.csv, network_topology.csv, network.png/pdf
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- microbe_load_params()
microbe_library(c("Hmisc", "igraph"))

feature <- microbe_read_feature(p$feature_table)
fsamp <- setdiff(names(feature), "feature_id")

# 可选：按 metadata 的某组取样本子集
if (!is.null(p$metadata)) {
  meta <- microbe_read_metadata(p$metadata)
  fsamp <- intersect(meta$sample_name, fsamp)
  if (!is.null(p$group)) {
    sel <- meta$sample_name[meta$group_name == p$group]
    fsamp <- intersect(sel, fsamp)
  }
}
if (length(fsamp) < 4) stop("建网样本数不足（<4），Spearman 相关不稳健")

# 汇总层级或按 feature
level <- microbe_opt(p, "level", NULL)
if (!is.null(level) && !is.null(p$taxonomy)) {
  taxonomy <- microbe_read_taxonomy(p$taxonomy)
  mat <- microbe_collapse(feature, taxonomy, level, fsamp)
} else {
  taxonomy <- if (!is.null(p$taxonomy)) microbe_read_taxonomy(p$taxonomy) else NULL
  mat <- microbe_feature_matrix(feature, fsamp)
}

# 过滤：检出率 + 取最丰 top_n
min_prev <- microbe_opt(p, "min_prev", max(2, floor(ncol(mat) / 3)))
mat <- mat[rowSums(mat > 0) >= min_prev, , drop = FALSE]
top_n <- microbe_opt(p, "top_n", 150)
if (nrow(mat) > top_n) mat <- mat[order(rowMeans(microbe_relabund(mat)), decreasing = TRUE)[seq_len(top_n)], , drop = FALSE]
if (nrow(mat) < 3) stop("过滤后类群不足 3 个，无法建网")

# ---- 相关 (Hmisc::rcorr) + 阈值筛边 ---------------------------------------
method <- microbe_opt(p, "method", "spearman")
rc <- Hmisc::rcorr(t(mat), type = method)
r <- rc$r; P <- rc$P
diag(P) <- 1
if (isTRUE(microbe_opt(p, "padjust", TRUE))) {
  ut <- upper.tri(P)
  padj <- P; padj[ut] <- p.adjust(P[ut], method = "BH")
  padj[lower.tri(padj)] <- t(padj)[lower.tri(padj)]
  P <- padj
}
r_thr <- microbe_opt(p, "r_threshold", 0.7)
p_thr <- microbe_opt(p, "p_threshold", 0.05)

ut <- which(upper.tri(r) & abs(r) >= r_thr & P < p_thr, arr.ind = TRUE)
taxa <- rownames(mat)
edges <- data.frame(
  from = taxa[ut[, 1]], to = taxa[ut[, 2]],
  r = r[ut], p = P[ut],
  sign = ifelse(r[ut] > 0, "positive", "negative"),
  stringsAsFactors = FALSE
)
microbe_write_csv(edges, p$outdir, "network_edges")

# ---- 建图 + 拓扑 -----------------------------------------------------------
g <- igraph::graph_from_data_frame(edges[, c("from", "to")], directed = FALSE,
                                   vertices = data.frame(name = taxa))
igraph::E(g)$weight <- abs(edges$r)
igraph::E(g)$sign <- edges$sign

# 社区/模块度（Louvain，权重=|r|）
comm <- tryCatch(igraph::cluster_louvain(g, weights = igraph::E(g)$weight),
                 error = function(e) igraph::cluster_fast_greedy(igraph::simplify(g)))
mem <- igraph::membership(comm)
modu <- igraph::modularity(comm)
deg <- igraph::degree(g)
clo <- suppressWarnings(igraph::closeness(g, normalized = TRUE)); clo[is.na(clo)] <- 0
betw <- igraph::betweenness(g, normalized = TRUE)

# keystone：度与接近中心性均居前的枢纽节点
hub <- (deg >= stats::quantile(deg, 0.90)) & (clo >= stats::median(clo)) & (deg > 0)
nodes <- data.frame(taxon = taxa, module = as.integer(mem[taxa]),
                    degree = deg[taxa], closeness = round(clo[taxa], 4),
                    betweenness = round(betw[taxa], 4), keystone = hub[taxa],
                    stringsAsFactors = FALSE)
if (!is.null(taxonomy)) {
  ann_level <- if (!is.null(level)) NULL else "Phylum"
  if (!is.null(ann_level) && ann_level %in% names(taxonomy)) {
    nodes$Phylum <- taxonomy$Phylum[match(nodes$taxon, taxonomy$feature_id)]
  }
}
nodes <- nodes[order(-nodes$degree), ]
microbe_write_csv(nodes, p$outdir, "network_nodes")

n_pos <- sum(edges$sign == "positive"); n_neg <- sum(edges$sign == "negative")
topo <- data.frame(
  metric = c("nodes", "edges", "positive_edges", "negative_edges", "positive_pct",
             "avg_degree", "avg_path_length", "clustering_coef", "modularity",
             "n_modules", "n_keystone"),
  value = c(igraph::vcount(g), igraph::ecount(g), n_pos, n_neg,
            round(100 * n_pos / max(1, igraph::ecount(g)), 2),
            round(mean(deg), 3),
            round(suppressWarnings(igraph::mean_distance(g)), 3),
            round(igraph::transitivity(g, type = "global"), 3),
            round(modu, 3), length(unique(mem)), sum(hub))
)
microbe_write_csv(topo, p$outdir, "network_topology")
microbe_metric(sprintf("network nodes=%d edges=%d pos%%=%.1f avg_degree=%.2f modularity=%.3f keystone=%d",
                       igraph::vcount(g), igraph::ecount(g),
                       100 * n_pos / max(1, igraph::ecount(g)), mean(deg), modu, sum(hub)))

# ---- 绘图 (igraph base graphics) -------------------------------------------
lay_name <- microbe_opt(p, "layout", "fr")
set.seed(123)
lay <- if (identical(lay_name, "circle")) igraph::layout_in_circle(g) else igraph::layout_with_fr(g)
mcols <- microbe_palette(length(unique(mem)), "taxa")
vcol <- mcols[as.integer(factor(mem[taxa]))]
ecol <- ifelse(edges$sign == "positive", grDevices::adjustcolor("#d6604d", 0.55),
               grDevices::adjustcolor("#4393c3", 0.55))
vsize <- 3 + 7 * (deg[taxa] / max(1, max(deg)))
show_label <- isTRUE(microbe_opt(p, "label", FALSE))
vlabel <- if (show_label) taxa else ifelse(hub[taxa], taxa, NA)

microbe_save_base(p$outdir, microbe_opt(p, "name", "network"), function() {
  graphics::par(mar = c(1, 1, 2, 1))
  igraph::plot.igraph(g, layout = lay, vertex.color = vcol, vertex.frame.color = "grey40",
                      vertex.size = vsize, vertex.label = vlabel, vertex.label.cex = 0.6,
                      vertex.label.color = "black", vertex.label.dist = 0.6,
                      edge.color = ecol, edge.width = 1.2 * abs(edges$r))
  graphics::title(sprintf("Co-occurrence network (%s |r|>=%.2f, P<%.2g)\nnodes=%d edges=%d  +%.0f%%/-%.0f%%  modularity=%.2f",
                          method, r_thr, p_thr, igraph::vcount(g), igraph::ecount(g),
                          100 * n_pos / max(1, igraph::ecount(g)),
                          100 * n_neg / max(1, igraph::ecount(g)), modu), cex.main = 0.8)
  graphics::legend("bottomleft", legend = c("positive", "negative"),
                   col = c("#d6604d", "#4393c3"), lty = 1, lwd = 2, bty = "n", cex = 0.7)
}, width = microbe_opt(p, "width", 7.5), height = microbe_opt(p, "height", 7),
   dpi = microbe_opt(p, "dpi", 300))

cat("MICROBE_DONE: network nodes=", igraph::vcount(g), "edges=", igraph::ecount(g),
    "modularity=", round(modu, 3), "keystone=", sum(hub), "\n")
