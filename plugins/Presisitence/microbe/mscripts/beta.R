# beta.R —— β多样性排序 (PCoA/NMDS) + PERMANOVA/ANOSIM（对齐 Liu2023 Fig1c,f / Zhou2022 Fig1c,d）
# params: feature_table, metadata, outdir,
#   method("pcoa"|"nmds"，默认 pcoa), distance("bray"|"jaccard"|"euclidean"，默认 bray),
#   test("permanova"|"anosim"|"both"，默认 permanova), permutations(默认 999),
#   relabund(bool,默认T 先转相对丰度), ellipse(bool,默认T), label(bool,默认F),
#   palette, dpi,width,height,name
# 输出: beta_scores.csv, beta_stats.csv, beta_<method>.png/pdf
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- microbe_load_params()
microbe_library(c("vegan", "ggplot2"))
use_repel <- microbe_has("ggrepel")

feature <- microbe_read_feature(p$feature_table)
meta <- microbe_read_metadata(p$metadata)
al <- microbe_align(feature, meta)
samples <- al$samples; meta <- al$meta

m <- microbe_feature_matrix(feature, samples)
if (isTRUE(microbe_opt(p, "relabund", TRUE))) m <- microbe_relabund(m)
comm <- t(m)                                     # 行=样本 列=feature

distance <- microbe_opt(p, "distance", "bray")
d <- vegan::vegdist(comm, method = distance)
grp <- factor(meta$group_name[match(rownames(comm), meta$sample_name)],
              levels = unique(meta$group_name))

method <- microbe_opt(p, "method", "pcoa")
if (identical(method, "nmds")) {
  set.seed(123)
  ord <- vegan::metaMDS(d, k = 2, trymax = 50, trace = 0)
  pts <- as.data.frame(ord$points)
  names(pts)[1:2] <- c("Axis1", "Axis2")
  xlab <- "NMDS1"; ylab <- "NMDS2"
  subtitle <- sprintf("NMDS (%s)  stress = %.3f", distance, ord$stress)
} else {
  pc <- stats::cmdscale(d, k = 2, eig = TRUE)
  pts <- as.data.frame(pc$points)
  names(pts) <- c("Axis1", "Axis2")
  eig <- pc$eig; pos <- eig[eig > 0]
  ve <- 100 * eig[1:2] / sum(pos)
  xlab <- sprintf("PCoA1 (%.2f%%)", ve[1]); ylab <- sprintf("PCoA2 (%.2f%%)", ve[2])
  subtitle <- sprintf("PCoA on %s distance", distance)
}
pts$sample_name <- rownames(pts)
pts$group <- grp

# ---- 组间差异检验 ----------------------------------------------------------
perm <- microbe_opt(p, "permutations", 999)
test <- microbe_opt(p, "test", "permanova")
stat_rows <- list()
ann <- character(0)
if (test %in% c("permanova", "both")) {
  ad <- vegan::adonis2(d ~ grp, permutations = perm)
  r2 <- ad$R2[1]; pv <- ad$`Pr(>F)`[1]; fval <- ad$F[1]
  stat_rows[["PERMANOVA"]] <- data.frame(test = "PERMANOVA", statistic = fval, R2 = r2, p_value = pv)
  ann <- c(ann, sprintf("PERMANOVA: R2 = %.3f, P = %.3f", r2, pv))
}
if (test %in% c("anosim", "both")) {
  an <- vegan::anosim(d, grp, permutations = perm)
  stat_rows[["ANOSIM"]] <- data.frame(test = "ANOSIM", statistic = an$statistic, R2 = NA, p_value = an$signif)
  ann <- c(ann, sprintf("ANOSIM: R = %.3f, P = %.3f", an$statistic, an$signif))
}
stats_df <- do.call(rbind, stat_rows)
microbe_write_csv(stats_df, p$outdir, "beta_stats")
microbe_write_csv(pts[, c("sample_name", "group", "Axis1", "Axis2")], p$outdir, "beta_scores")
for (a in ann) microbe_metric(a)

cols <- microbe_group_colors(grp)
pl <- ggplot2::ggplot(pts, ggplot2::aes(x = Axis1, y = Axis2, color = group)) +
  ggplot2::geom_hline(yintercept = 0, linetype = "dashed", color = "grey80") +
  ggplot2::geom_vline(xintercept = 0, linetype = "dashed", color = "grey80") +
  ggplot2::geom_point(size = 3, alpha = 0.85) +
  ggplot2::scale_color_manual(values = cols) +
  ggplot2::labs(x = xlab, y = ylab, color = "Group",
                title = subtitle,
                subtitle = paste(ann, collapse = "   ")) +
  theme_microbe() +
  ggplot2::theme(plot.subtitle = ggplot2::element_text(hjust = 0.5, size = 9))

if (isTRUE(microbe_opt(p, "ellipse", TRUE)) && nlevels(grp) > 1 &&
    all(table(grp) >= 3)) {
  pl <- pl + ggplot2::stat_ellipse(ggplot2::aes(fill = group), geom = "polygon",
                                   alpha = 0.12, level = 0.95, show.legend = FALSE) +
    ggplot2::scale_fill_manual(values = cols)
}
if (isTRUE(microbe_opt(p, "label", FALSE))) {
  if (use_repel) pl <- pl + ggrepel::geom_text_repel(ggplot2::aes(label = sample_name),
                                                      size = 2.6, color = "black", max.overlaps = Inf)
  else pl <- pl + ggplot2::geom_text(ggplot2::aes(label = sample_name), size = 2.4,
                                     color = "black", vjust = -0.7)
}

microbe_save(pl, p$outdir, microbe_opt(p, "name", paste0("beta_", method)),
             width = microbe_opt(p, "width", 6.5), height = microbe_opt(p, "height", 5.5),
             dpi = microbe_opt(p, "dpi", 300))
cat("MICROBE_DONE: beta", method, distance, "|", paste(ann, collapse = " | "), "\n")
