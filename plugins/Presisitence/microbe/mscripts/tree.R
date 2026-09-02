# tree.R —— 分类树/系统发育树 + 丰度环（对齐 Zhou2022 Fig3a,b: 树 + 相对丰度热环 + 类群着色）
#   无测序数据时以「分类学层级」构树(ape::as.phylo formula)；失败则退化为按丰度谱聚类构树。
# params: feature_table, taxonomy, metadata, outdir,
#   level(树尖层级,默认 "Genus"), color_by(按此分类等级给树尖着色,默认 "Phylum"),
#   layout("circular"|"fan"|"rectangular"，默认 circular), ring(bool,默认T 加组均值丰度环),
#   top_n(树尖上限,默认 60), dpi,width,height,name
# 输出: tree_tip_abundance.csv + tree.png/pdf
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- microbe_load_params()
microbe_library(c("ape", "ggtree", "ggplot2"))

feature <- microbe_read_feature(p$feature_table)
taxonomy <- microbe_read_taxonomy(p$taxonomy)
meta <- microbe_read_metadata(p$metadata)
al <- microbe_align(feature, meta)
samples <- al$samples; meta <- al$meta

level <- microbe_opt(p, "level", "Genus")
color_by <- microbe_opt(p, "color_by", "Phylum")
top_n <- microbe_opt(p, "top_n", 60)

agg <- microbe_collapse(feature, taxonomy, level, samples)     # counts taxa x samples
ra <- microbe_relabund(agg)
tips <- rownames(ra)[order(rowMeans(ra), decreasing = TRUE)]
tips <- setdiff(tips, c("Unclassified"))
tips <- utils::head(tips, top_n)
if (length(tips) < 3) stop("可用树尖类群不足 3 个")
ra <- ra[tips, , drop = FALSE]

# 树尖对应的高阶分类（每个 tip 取首个匹配 feature 的分类行）
ranks_all <- c("Kingdom", "Phylum", "Class", "Order", "Family", "Genus", "Species")
idx <- match(level, ranks_all)
use_ranks <- intersect(ranks_all[seq_len(idx)], names(taxonomy))
taxrow <- function(tip, r) {
  hit <- which(taxonomy[[level]] == tip)
  if (length(hit) == 0) return(NA)
  v <- taxonomy[[r]][hit[1]]
  if (is.na(v) || v == "") paste0("unclassified_", r) else v
}
taxcols <- lapply(use_ranks, function(r) unname(vapply(tips, taxrow, character(1), r = r)))
names(taxcols) <- use_ranks
taxdf <- as.data.frame(taxcols, stringsAsFactors = FALSE, check.names = FALSE)
taxdf[[level]] <- make.unique(as.character(tips))   # 去重 tip 标签
tips <- taxdf[[level]]
rownames(ra) <- tips
for (r in names(taxdf)) taxdf[[r]] <- factor(taxdf[[r]])

# ---- 构树：分类学 formula 树，失败则退化为丰度谱聚类树 ---------------------
tr <- NULL
if (length(use_ranks) >= 2) {
  frm <- stats::as.formula(paste("~", paste(use_ranks, collapse = "/")))
  tr <- tryCatch(ape::as.phylo(frm, data = taxdf, collapse.singles = FALSE),
                 error = function(e) NULL)
}
if (is.null(tr)) {
  microbe_metric("分类学构树失败，退化为按相对丰度谱 (1-Pearson) 层次聚类构树")
  dd <- stats::as.dist(1 - stats::cor(t(ra)))
  tr <- ape::as.phylo(stats::hclust(dd, method = "average"))
}

# 树尖着色注释
tipmeta <- data.frame(label = tips,
                      color_group = if (color_by %in% names(taxonomy)) {
                        vapply(rownames(ra), function(t) {
                          hit <- which(taxonomy[[level]] == sub("\\.[0-9]+$", "", t))
                          v <- if (length(hit)) taxonomy[[color_by]][hit[1]] else NA
                          if (is.na(v) || v == "") "Unclassified" else v
                        }, character(1))
                      } else "NA",
                      stringsAsFactors = FALSE)

lay <- microbe_opt(p, "layout", "circular")
gt <- ggtree::ggtree(tr, layout = lay, linewidth = 0.4) %<+% tipmeta +
  ggtree::geom_tippoint(ggplot2::aes(color = color_group), size = 1.8) +
  ggplot2::scale_color_manual(values = microbe_palette(length(unique(tipmeta$color_group)), "taxa"),
                              name = color_by) +
  ggtree::geom_tiplab(size = 1.8, offset = 0.02, align = TRUE)

# ---- 组均值相对丰度环 ------------------------------------------------------
if (isTRUE(microbe_opt(p, "ring", TRUE))) {
  grp <- meta$group_name[match(colnames(ra), meta$sample_name)]
  glv <- unique(meta$group_name)
  gm <- sapply(glv, function(g) rowMeans(ra[, grp == g, drop = FALSE]))
  gm <- as.data.frame(gm); rownames(gm) <- tips; colnames(gm) <- glv
  microbe_write_csv(data.frame(tip = rownames(gm), gm, check.names = FALSE),
                    p$outdir, "tree_tip_abundance")
  gt <- ggtree::gheatmap(gt, gm, offset = 0.15, width = 0.25, font.size = 2,
                         colnames_angle = 90, colnames_offset_y = 0) +
    ggplot2::scale_fill_gradient(low = "white", high = "#238b45", name = "Rel. abund.")
} else {
  microbe_write_csv(data.frame(tip = rownames(ra), ra, check.names = FALSE),
                    p$outdir, "tree_tip_abundance")
}

microbe_save(gt, p$outdir, microbe_opt(p, "name", "tree"),
             width = microbe_opt(p, "width", 8), height = microbe_opt(p, "height", 8),
             dpi = microbe_opt(p, "dpi", 300))
cat("MICROBE_DONE: tree tips=", length(tips), "level=", level, "layout=", lay, "\n")
