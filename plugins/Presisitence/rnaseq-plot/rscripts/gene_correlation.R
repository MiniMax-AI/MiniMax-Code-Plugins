# gene_correlation.R —— 基因-基因相关性热图（气泡热图，圆点大小=|r|）
# params: fpkm(gene_fpkm.csv), sample_group, outdir,
#         genes1(向量) 或 gene_list1(CSV), genes2(向量) 或 gene_list2(CSV, 缺省=genes1),
#         dpi(300), width,height, name
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("dplyr", "ggplot2", "reshape2", "scales"))

fpkm <- rgraph_read_matrix(p$fpkm)
sg <- rgraph_read_sample_group(p$sample_group)
g1 <- if (!is.null(p$genes1)) p$genes1 else read.csv(p$gene_list1, check.names = FALSE)$gene_id
g2 <- if (!is.null(p$genes2)) p$genes2 else if (!is.null(p$gene_list2))
  read.csv(p$gene_list2, check.names = FALSE)$gene_id else g1

sub <- fpkm[fpkm$gene_id %in% unique(c(g1, g2)), c("gene_id", sg$sample_name)]
rownames(sub) <- sub$gene_id; sub$gene_id <- NULL
sub[is.na(sub)] <- 0
logm <- log2(sub + 1)
cm <- cor(t(logm), use = "pairwise.complete.obs")   # 基因 x 基因
cm <- cm[rownames(cm) %in% g1, colnames(cm) %in% g2, drop = FALSE]

rgraph_write_csv(as.data.frame(cbind(gene_id = rownames(cm), cm)), p$outdir, "correlation")

df <- reshape2::melt(cm); df$size <- abs(df$value)
pl <- ggplot2::ggplot(df, ggplot2::aes(x = Var2, y = Var1)) +
  ggplot2::geom_tile(color = "black", fill = "white", linewidth = 0.4) +
  ggplot2::geom_point(ggplot2::aes(fill = value, size = size, color = value), shape = 21,
                      stroke = 0.4, alpha = 0.85) +
  ggplot2::scale_color_gradient2(low = "#2167ad", mid = "#d8d4d4", high = "red", guide = "none") +
  ggplot2::scale_size(range = c(4, 12), guide = "none") +
  ggplot2::scale_fill_gradientn(colors = grDevices::colorRampPalette(c("#2167ad", "white", "red"))(100),
                                limits = c(-1, 1), name = "r") +
  ggplot2::labs(title = "Pearson correlation between genes", x = NULL, y = NULL) +
  theme_rgraph() +
  ggplot2::theme(axis.text.x = ggplot2::element_text(angle = 45, hjust = 1)) +
  ggplot2::coord_fixed()

nr <- nrow(cm); nc <- ncol(cm)
rgraph_save(pl, p$outdir, rgraph_opt(p, "name", "gene_correlation"),
            width = rgraph_opt(p, "width", max(6, nc * 0.6)),
            height = rgraph_opt(p, "height", max(6, nr * 0.6)),
            dpi = rgraph_opt(p, "dpi", 300))
cat("RGRAPH_DONE: gene_correlation rows=", nr, "cols=", nc, "\n")
