# composition.R —— 物种组成堆叠柱状图（对齐 Liu2023 Fig1g / Zhou2022 Fig4k,l, Fig5）
# params: feature_table, taxonomy, metadata, outdir,
#   level("Phylum"|"Class"|"Order"|"Family"|"Genus"|"Species"，默认 Phylum),
#   top_n(默认 10 其余合并 Others), mode("group"|"sample"，默认 group 组内均值),
#   dpi,width,height,name
# 输出: composition_<level>.csv(相对丰度表) + composition_<level>.png/pdf
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- microbe_load_params()
microbe_library(c("ggplot2", "reshape2"))

feature <- microbe_read_feature(p$feature_table)
taxonomy <- microbe_read_taxonomy(p$taxonomy)
meta <- microbe_read_metadata(p$metadata)
al <- microbe_align(feature, meta)
samples <- al$samples; meta <- al$meta

level <- microbe_opt(p, "level", "Phylum")
top_n <- microbe_opt(p, "top_n", 10)
mode <- microbe_opt(p, "mode", "group")

agg <- microbe_collapse(feature, taxonomy, level, samples)   # counts taxa x samples
agg <- microbe_top_taxa(agg, top_n)                          # top_n + Others
ra <- microbe_relabund(agg)                                  # 每样本相对丰度

if (identical(mode, "group")) {
  grp <- meta$group_name[match(colnames(ra), meta$sample_name)]
  glv <- unique(meta$group_name)
  gm <- sapply(glv, function(g) rowMeans(ra[, grp == g, drop = FALSE]))
  colnames(gm) <- glv
  ra <- microbe_relabund(gm)                                 # 组内均值后再归一
  xlab <- "Group"
} else {
  ra <- ra[, meta$sample_name[order(meta$group_name)], drop = FALSE]
  xlab <- "Sample"
}

tab <- data.frame(Taxon = rownames(ra), ra, check.names = FALSE)
microbe_write_csv(tab, p$outdir, paste0("composition_", level))

# 类群顺序：Others/Unclassified 置底，其余按总丰度降序
taxa_order <- rownames(ra)
special <- intersect(c("Others", "Unclassified"), taxa_order)
main <- setdiff(taxa_order, special)
main <- main[order(rowSums(ra[main, , drop = FALSE]), decreasing = FALSE)]  # 底->顶
taxa_levels <- c(special, main)

long <- reshape2::melt(as.matrix(ra), varnames = c("Taxon", "Unit"), value.name = "RelAbund")
long$Taxon <- factor(long$Taxon, levels = taxa_levels)
long$Unit <- factor(long$Unit, levels = colnames(ra))

cols <- microbe_taxa_colors(taxa_levels)
pl <- ggplot2::ggplot(long, ggplot2::aes(x = Unit, y = RelAbund, fill = Taxon)) +
  ggplot2::geom_bar(stat = "identity", width = 0.75, color = "white", linewidth = 0.1) +
  ggplot2::scale_fill_manual(values = cols, breaks = rev(taxa_levels)) +
  ggplot2::scale_y_continuous(expand = c(0, 0), labels = scales::percent_format(accuracy = 1)) +
  ggplot2::labs(x = xlab, y = "Relative abundance", fill = level) +
  theme_microbe() +
  ggplot2::theme(axis.text.x = ggplot2::element_text(angle = 45, hjust = 1),
                 legend.key.size = ggplot2::unit(0.4, "cm"))

n_unit <- ncol(ra)
microbe_save(pl, p$outdir, microbe_opt(p, "name", paste0("composition_", level)),
             width = microbe_opt(p, "width", max(4.5, n_unit * 0.5 + 2.5)),
             height = microbe_opt(p, "height", 5.5), dpi = microbe_opt(p, "dpi", 300))
cat("MICROBE_DONE: composition level=", level, "units=", n_unit, "taxa=", nrow(ra),
    "mode=", mode, "\n")
