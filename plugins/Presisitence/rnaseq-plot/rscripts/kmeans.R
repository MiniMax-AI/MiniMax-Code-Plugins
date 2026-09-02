# kmeans.R —— 目标基因 K-means 聚类：肘部图 + 聚类热图 + 各簇表达趋势 + 成员表
# params: fpkm, sample_group, outdir, gene_list(CSV, gene_id) 或 genes(向量),
#         k(簇数,默认4), kmax(肘部图最大k,默认10), seed(123), dpi(300)
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("dplyr", "tidyr", "ggplot2", "pheatmap"))

k <- rgraph_opt(p, "k", 4)
fpkm <- rgraph_read_matrix(p$fpkm)
sg <- rgraph_read_sample_group(p$sample_group)
genes <- if (!is.null(p$genes)) p$genes else read.csv(p$gene_list, check.names = FALSE)$gene_id

sub <- fpkm[fpkm$gene_id %in% genes, c("gene_id", sg$sample_name), drop = FALSE]
rownames(sub) <- sub$gene_id; sub$gene_id <- NULL
m <- as.matrix(sub); m[is.na(m)] <- 0
logm <- log2(m + 1)
logm <- logm[rowSums(logm) != 0, , drop = FALSE]
logm <- logm[, colSums(logm) != 0, drop = FALSE]
z <- t(scale(t(logm)))
z[is.na(z)] <- 0
if (nrow(z) < k) stop("基因数少于簇数 k")

# ---- 肘部图（base wss，不依赖 factoextra）---------------------------------
set.seed(rgraph_opt(p, "seed", 123))
kmax <- min(rgraph_opt(p, "kmax", 10), nrow(z) - 1)
wss <- sapply(1:kmax, function(kk) kmeans(z, centers = kk, nstart = 10)$tot.withinss)
elbow <- data.frame(k = 1:kmax, wss = wss)
pl_e <- ggplot2::ggplot(elbow, ggplot2::aes(k, wss)) +
  ggplot2::geom_line(color = "#4575b4") + ggplot2::geom_point(size = 2, color = "#4575b4") +
  ggplot2::scale_x_continuous(breaks = 1:kmax) +
  ggplot2::labs(x = "Number of clusters k", y = "Total within-cluster SS",
                title = "Elbow method") + theme_rgraph()
rgraph_save(pl_e, p$outdir, "elbow", width = 7, height = 5, dpi = rgraph_opt(p, "dpi", 300))

# ---- K-means + 成员表 -------------------------------------------------------
set.seed(rgraph_opt(p, "seed", 123))
km <- kmeans(z, centers = k, nstart = 25)
for (cn in 1:k)
  rgraph_write_csv(data.frame(gene_id = names(km$cluster[km$cluster == cn])),
                   p$outdir, paste0("cluster_", cn, "_genes"))

# ---- 聚类热图（pheatmap: 行按簇排序 + 行/列注释）--------------------------
ord <- order(km$cluster)
zo <- z[ord, , drop = FALSE]
cl <- km$cluster[ord]
ann_row <- data.frame(Cluster = factor(cl)); rownames(ann_row) <- rownames(zo)
ann_col <- data.frame(Group = factor(sg$group_name[match(colnames(zo), sg$sample_name)],
                                     levels = unique(sg$group_name)))
rownames(ann_col) <- colnames(zo)
gcol <- rgraph_palette(nlevels(ann_col$Group), rgraph_opt(p, "palette", "course"))
names(gcol) <- levels(ann_col$Group)
ccol <- rgraph_palette(k, "colorblind")[1:k]; names(ccol) <- as.character(1:k)
pal <- grDevices::colorRampPalette(c("blue", "white", "red"))(100)
gaps <- cumsum(as.numeric(table(cl)))
for (fmt in c("png", "pdf")) {
  f <- file.path(p$outdir, paste0("kmeans_heatmap.", fmt))
  rgraph_ensure_dir(p$outdir)
  pheatmap::pheatmap(zo, scale = "none", cluster_rows = FALSE, cluster_cols = FALSE,
                     color = pal, border_color = NA, show_rownames = nrow(zo) <= 60,
                     annotation_row = ann_row, annotation_col = ann_col,
                     annotation_colors = list(Cluster = ccol, Group = gcol),
                     gaps_row = gaps, fontsize_col = 9, angle_col = 45,
                     width = 8, height = max(5, nrow(zo) * 0.15 + 2), filename = f)
  rgraph_emit(f)
}

# ---- 各簇表达趋势线 --------------------------------------------------------
long <- as.data.frame(z) %>% dplyr::mutate(gene_id = rownames(z), Cluster = factor(km$cluster)) %>%
  tidyr::pivot_longer(cols = -c(gene_id, Cluster), names_to = "Sample", values_to = "Expression")
long$Sample <- factor(long$Sample, levels = colnames(z))
for (cn in 1:k) {
  cc <- long %>% dplyr::filter(Cluster == cn)
  sm <- cc %>% dplyr::group_by(Sample) %>%
    dplyr::summarise(mean = mean(Expression), lo = min(Expression), hi = max(Expression), .groups = "drop")
  pl <- ggplot2::ggplot() +
    ggplot2::geom_point(data = cc, ggplot2::aes(Sample, Expression), color = "grey70", size = 1.5, alpha = 0.5) +
    ggplot2::geom_ribbon(data = sm, ggplot2::aes(Sample, ymin = lo, ymax = hi, group = 1), fill = "red", alpha = 0.2) +
    ggplot2::geom_line(data = sm, ggplot2::aes(Sample, mean, group = 1), color = "red", linewidth = 1) +
    ggplot2::geom_point(data = sm, ggplot2::aes(Sample, mean), fill = "red", shape = 21, size = 3, color = "white") +
    ggplot2::labs(title = paste0("Cluster ", cn, " (n=", sum(km$cluster == cn), ")"),
                  x = NULL, y = "Z-score") + theme_rgraph() +
    ggplot2::theme(axis.text.x = ggplot2::element_text(angle = 45, hjust = 1))
  rgraph_save(pl, p$outdir, paste0("cluster_", cn, "_trend"), width = 8, height = 5, dpi = rgraph_opt(p, "dpi", 300))
}
cat("RGRAPH_DONE: kmeans k=", k, "genes=", nrow(z), "\n")
