#!/usr/bin/env Rscript

suppressPackageStartupMessages({
  library(jsonlite)
  library(ggplot2)
})

args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 1L) stop("Expected one JSON configuration path")
cfg <- jsonlite::fromJSON(args[[1]], simplifyVector = FALSE)

pick <- function(df, explicit = NULL, choices = character()) {
  if (!is.null(explicit) && nzchar(explicit) && explicit %in% names(df)) return(explicit)
  hit <- choices[choices %in% names(df)]
  if (length(hit)) hit[[1]] else NULL
}
read_table <- function(file) {
  sep <- if (grepl("\\.csv$", file, ignore.case = TRUE)) "," else "\t"
  read.delim(file, sep = sep, header = TRUE, check.names = FALSE, stringsAsFactors = FALSE, quote = '"', comment.char = "")
}
ratio_number <- function(x) {
  x <- as.character(x)
  vapply(x, function(z) {
    if (grepl("/", z, fixed = TRUE)) { q <- strsplit(z, "/", fixed = TRUE)[[1]]; return(as.numeric(q[[1]]) / as.numeric(q[[2]])) }
    as.numeric(z)
  }, numeric(1))
}
theme_pub <- function() theme_classic(base_size = 11, base_family = "sans") + theme(axis.title = element_text(face = "bold"), legend.title = element_text(face = "bold"), plot.title = element_text(face = "bold"), strip.background = element_rect(fill = "#EEF4F1", colour = NA))
save_plot <- function(p, png, pdf, width, height, dpi) {
  ggsave(png, p, width = width, height = height, dpi = dpi, bg = "white")
  ggsave(pdf, p, width = width, height = height, device = cairo_pdf, bg = "white")
}

dir.create(cfg$output_dir, recursive = TRUE, showWarnings = FALSE)
prefix <- file.path(cfg$output_dir, cfg$output_name)
png <- paste0(prefix, ".png")
pdf <- paste0(prefix, ".pdf")
plot_data_path <- paste0(prefix, ".plot-data.csv")
df <- read_table(cfg$input_path)
if (!nrow(df)) stop("Input table has no rows")
cols <- cfg$columns
opt <- cfg$options
alpha <- ifelse(is.null(opt$alpha), 0.05, as.numeric(opt$alpha))
lfc <- ifelse(is.null(opt$lfc), 1, as.numeric(opt$lfc))
top_n <- ifelse(is.null(opt$top_n), 30L, as.integer(opt$top_n))
label_n <- ifelse(is.null(opt$label_n), 10L, as.integer(opt$label_n))
width <- ifelse(is.null(opt$width), 7, as.numeric(opt$width))
height <- ifelse(is.null(opt$height), 5.5, as.numeric(opt$height))
dpi <- ifelse(is.null(opt$dpi), 300L, as.integer(opt$dpi))
transform <- ifelse(is.null(opt$transform), "auto", opt$transform)

if (cfg$plot_type == "volcano") {
  xcol <- pick(df, cols$x, c("log2FoldChange", "log2FC", "logFC", "effect"))
  ycol <- pick(df, cols$y, c("padj", "FDR", "adj.P.Val", "pvalue", "PValue"))
  labcol <- pick(df, cols$label, c("gene", "gene_id", "Gene", "ID", names(df)[[1]]))
  if (is.null(xcol) || is.null(ycol)) stop("Volcano plot requires fold-change and adjusted-p columns")
  out <- data.frame(label = as.character(df[[labcol]]), effect = as.numeric(df[[xcol]]), p = pmax(as.numeric(df[[ycol]]), .Machine$double.xmin))
  out$status <- ifelse(out$p < alpha & out$effect >= lfc, "Up", ifelse(out$p < alpha & out$effect <= -lfc, "Down", "Not significant"))
  out$neglog10p <- -log10(out$p)
  out$show_label <- ""
  idx <- head(order(out$p, -abs(out$effect), na.last = NA), label_n)
  out$show_label[idx] <- out$label[idx]
  p <- ggplot(out, aes(effect, neglog10p, colour = status)) + geom_point(alpha = 0.75, size = 1.8) +
    geom_vline(xintercept = c(-lfc, lfc), linetype = 2, colour = "grey45") + geom_hline(yintercept = -log10(alpha), linetype = 2, colour = "grey45") +
    scale_colour_manual(values = c(Down = "#3B75AF", `Not significant` = "#B8B8B8", Up = "#D8574C")) + labs(x = "log2 fold change", y = "-log10 adjusted P", colour = NULL, title = "Differential expression") + theme_pub()
  if (label_n > 0 && requireNamespace("ggrepel", quietly = TRUE)) p <- p + ggrepel::geom_text_repel(aes(label = show_label), max.overlaps = Inf, size = 3, box.padding = 0.25, show.legend = FALSE)
} else if (cfg$plot_type %in% c("pca", "heatmap")) {
  gene_col <- pick(df, cols$gene, c("gene", "gene_id", "Gene", "ID", names(df)[[1]]))
  numeric_cols <- names(df)[vapply(df, is.numeric, logical(1))]
  if (length(numeric_cols) < 2) stop("PCA/heatmap requires at least two numeric sample columns")
  mat <- as.matrix(df[numeric_cols]); storage.mode(mat) <- "numeric"
  rownames(mat) <- make.unique(as.character(df[[gene_col]]))
  if (transform == "log2" || (transform == "auto" && all(mat >= 0, na.rm = TRUE) && max(mat, na.rm = TRUE) > 50)) mat <- log2(mat + 1)
  vars <- apply(mat, 1, var, na.rm = TRUE); keep <- head(order(vars, decreasing = TRUE, na.last = NA), min(top_n, nrow(mat)))
  if (cfg$plot_type == "pca") {
    fit <- prcomp(t(mat[keep, , drop = FALSE]), center = TRUE, scale. = TRUE)
    variance <- 100 * fit$sdev^2 / sum(fit$sdev^2)
    out <- data.frame(sample = rownames(fit$x), PC1 = fit$x[, 1], PC2 = fit$x[, 2], group = "Samples", check.names = FALSE)
    if (!is.null(cfg$metadata_path)) {
      meta <- read_table(cfg$metadata_path)
      sample_col <- pick(meta, cols$sample, c("sample", "sample_name", "Sample", names(meta)[[1]]))
      group_col <- pick(meta, cols$group, c("group", "group_name", "Group", "condition"))
      if (!is.null(sample_col) && !is.null(group_col)) out$group <- as.character(meta[[group_col]][match(out$sample, meta[[sample_col]])])
    }
    p <- ggplot(out, aes(PC1, PC2, colour = group, label = sample)) + geom_hline(yintercept = 0, colour = "grey90") + geom_vline(xintercept = 0, colour = "grey90") + geom_point(size = 3.2) +
      labs(x = sprintf("PC1 (%.1f%%)", variance[[1]]), y = sprintf("PC2 (%.1f%%)", variance[[2]]), colour = NULL, title = "Sample-level PCA") + theme_pub()
    if (requireNamespace("ggrepel", quietly = TRUE)) p <- p + ggrepel::geom_text_repel(size = 3, show.legend = FALSE)
  } else {
    out <- t(scale(t(mat[keep, , drop = FALSE])))
    out[!is.finite(out)] <- 0
    png(png, width = width, height = height, units = "in", res = dpi, bg = "white")
    pheatmap::pheatmap(out, border_color = NA, cluster_rows = TRUE, cluster_cols = TRUE, fontsize = 8, main = sprintf("Top %d variable genes (row z-score)", nrow(out)), color = colorRampPalette(c("#315B9A", "#F7F7F7", "#C6413A"))(101))
    dev.off()
    cairo_pdf(pdf, width = width, height = height)
    pheatmap::pheatmap(out, border_color = NA, cluster_rows = TRUE, cluster_cols = TRUE, fontsize = 8, main = sprintf("Top %d variable genes (row z-score)", nrow(out)), color = colorRampPalette(c("#315B9A", "#F7F7F7", "#C6413A"))(101))
    dev.off()
    out <- data.frame(gene = rownames(out), out, check.names = FALSE)
  }
} else if (cfg$plot_type == "expression-boxplot") {
  xcol <- pick(df, cols$x, c("group", "condition", "treatment")); ycol <- pick(df, cols$y, c("value", "expression", "abundance")); facetcol <- pick(df, cols$facet, c("gene", "feature"))
  if (is.null(xcol) || is.null(ycol)) stop("Expression boxplot requires x/group and y/value columns")
  out <- data.frame(group = as.factor(df[[xcol]]), value = as.numeric(df[[ycol]]), feature = if (is.null(facetcol)) "Expression" else as.character(df[[facetcol]]))
  p <- ggplot(out, aes(group, value, fill = group)) + geom_boxplot(width = 0.62, outlier.shape = NA, alpha = 0.7) + geom_jitter(width = 0.12, size = 1.5, alpha = 0.75) +
    scale_fill_brewer(palette = "Set2") + labs(x = NULL, y = "Expression", fill = NULL, title = "Expression distribution") + theme_pub() + theme(legend.position = "none")
  if (length(unique(out$feature)) > 1) p <- p + facet_wrap(~feature, scales = "free_y")
} else if (cfg$plot_type == "enrichment-dotplot") {
  termcol <- pick(df, cols$term, c("Description", "Term", "term", "pathway")); xcol <- pick(df, cols$x, c("GeneRatio", "gene_ratio", "RichFactor", "ratio")); sizecol <- pick(df, cols$size, c("Count", "count", "GeneCount")); colorcol <- pick(df, cols$color, c("padj", "p.adjust", "FDR", "pvalue")); facetcol <- pick(df, cols$facet, c("Category", "category", "Ontology"))
  if (any(vapply(list(termcol, xcol, sizecol, colorcol), is.null, logical(1)))) stop("Enrichment dotplot requires term, ratio, count, and adjusted-p columns")
  out <- data.frame(term = as.character(df[[termcol]]), ratio = ratio_number(df[[xcol]]), count = as.numeric(df[[sizecol]]), padj = pmax(as.numeric(df[[colorcol]]), .Machine$double.xmin), category = if (is.null(facetcol)) "Enrichment" else as.character(df[[facetcol]]))
  out <- out[order(out$padj, -out$ratio), , drop = FALSE]; out <- head(out, min(top_n, nrow(out))); out$term <- factor(out$term, levels = rev(unique(out$term)))
  p <- ggplot(out, aes(ratio, term, size = count, colour = -log10(padj))) + geom_point(alpha = 0.88) + scale_colour_viridis_c(option = "C", end = 0.92) +
    labs(x = "Gene ratio", y = NULL, size = "Count", colour = "-log10 adj. P", title = "Functional enrichment") + theme_pub()
  if (length(unique(out$category)) > 1) p <- p + facet_grid(category ~ ., scales = "free_y", space = "free_y")
} else stop("Unsupported plot type")

if (cfg$plot_type != "heatmap") save_plot(p, png, pdf, width, height, dpi)
write.csv(out, plot_data_path, row.names = FALSE, fileEncoding = "UTF-8")
manifest <- list(plot_type = cfg$plot_type, png = normalizePath(png, winslash = "/", mustWork = TRUE), pdf = normalizePath(pdf, winslash = "/", mustWork = TRUE), plot_data = normalizePath(plot_data_path, winslash = "/", mustWork = TRUE), rows = nrow(out), generated_at = format(Sys.time(), tz = "UTC", usetz = TRUE))
cat("RNA_FIGURE_RESULT=", jsonlite::toJSON(manifest, auto_unbox = TRUE), "\n", sep = "")
