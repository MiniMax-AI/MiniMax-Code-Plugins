# =============================================================================
# _common.R  —  microbe-mcp 共享 R 库
# 所有下游微生物组/扩增子分析模板都 source() 本文件，统一：参数读取、包预检、
# 元数据/特征表/分类表读入与对齐、按分类层级汇总、相对丰度、抽平、出版级主题、
# 配色、png+pdf 导出、产物/指标回传标记。
#
# 与 rgraph-mcp 的 _common.R 保持同构（便于统一维护），仅面向微生物组数据。
#   * 不 setwd()/不 rm(list=ls())；一切走参数与绝对/相对入参。
#   * 缺包时输出 MICROBE_MISSING_PACKAGES 标记并以状态码 3 退出，交由上层友好提示。
#   * 产物统一通过 MICROBE_OUTPUT 标记回传；关键统计量通过 MICROBE_METRIC 回传。
# =============================================================================

options(stringsAsFactors = FALSE, warn = 1)

# ---- 参数读取 ---------------------------------------------------------------
microbe_load_params <- function() {
  args <- commandArgs(trailingOnly = TRUE)
  if (length(args) < 1) stop("缺少参数文件路径 (params file)")
  e <- new.env()
  sys.source(args[[1]], envir = e)
  if (!exists("params", envir = e)) stop("参数文件未定义 params 列表")
  get("params", envir = e)
}

microbe_opt <- function(p, key, default = NULL) {
  v <- p[[key]]
  if (is.null(v)) default else v
}

`%||%` <- function(a, b) if (is.null(a)) b else a

# ---- 包预检 -----------------------------------------------------------------
microbe_need <- function(pkgs) {
  inst <- rownames(installed.packages())
  miss <- setdiff(pkgs, inst)
  if (length(miss) > 0) {
    cat("MICROBE_MISSING_PACKAGES:", paste(miss, collapse = ","), "\n")
    quit(save = "no", status = 3)
  }
  invisible(TRUE)
}

microbe_library <- function(pkgs) {
  microbe_need(pkgs)
  for (p in pkgs) suppressMessages(suppressWarnings(library(p, character.only = TRUE)))
  invisible(TRUE)
}

microbe_has <- function(pkg) requireNamespace(pkg, quietly = TRUE)

# ---- 产物 / 指标回传 / 目录 -------------------------------------------------
microbe_emit <- function(path) {
  cat("MICROBE_OUTPUT:", normalizePath(path, winslash = "/", mustWork = FALSE), "\n")
}

microbe_metric <- function(...) {
  cat("MICROBE_METRIC:", paste0(...), "\n")
}

microbe_ensure_dir <- function(path) {
  if (!dir.exists(path)) dir.create(path, recursive = TRUE, showWarnings = FALSE)
  invisible(path)
}

# ---- 读入：样本元数据 (sample_name + group[+group_name][+环境/代谢物列]) -----
microbe_read_metadata <- function(path) {
  md <- read.csv(path, header = TRUE, check.names = FALSE, stringsAsFactors = FALSE)
  # 首列容错为 sample_name
  cand <- c("sample_name", "SampleID", "sample", "Sample", "sample_id", "#SampleID")
  hit <- intersect(cand, names(md))
  if (length(hit) == 0) names(md)[1] <- "sample_name" else if (hit[1] != "sample_name") {
    names(md)[which(names(md) == hit[1])] <- "sample_name"
  }
  md <- md[!is.na(md$sample_name) & md$sample_name != "", , drop = FALSE]
  has_g  <- "group" %in% names(md)
  has_gn <- "group_name" %in% names(md)
  if (has_g && !has_gn) md$group_name <- md$group
  if (has_gn && !has_g) md$group <- md$group_name
  if (!has_g && !has_gn) { md$group <- md$sample_name; md$group_name <- md$sample_name }
  rownames(md) <- md$sample_name
  md
}

# ---- 读入：特征表 (feature_id + 各样本计数列) ------------------------------
microbe_read_feature <- function(path) {
  df <- read.csv(path, header = TRUE, check.names = FALSE, stringsAsFactors = FALSE)
  fid <- c("feature_id", "OTU_ID", "OTUID", "#OTU ID", "ASV_ID", "ASV", "OTU", "ID", "taxon")
  hit <- intersect(fid, names(df))
  if (length(hit) == 0) names(df)[1] <- "feature_id" else if (hit[1] != "feature_id") {
    names(df)[which(names(df) == hit[1])] <- "feature_id"
  }
  df <- df[!duplicated(df$feature_id), , drop = FALSE]
  df
}

# 转为数值矩阵：行=feature_id，列=样本
microbe_feature_matrix <- function(feature, samples = NULL) {
  m <- feature
  rownames(m) <- m$feature_id
  m$feature_id <- NULL
  if (!is.null(samples)) {
    miss <- setdiff(samples, colnames(m))
    if (length(miss) > 0) stop(paste0("以下样本不在特征表中: ", paste(miss, collapse = ", ")))
    m <- m[, samples, drop = FALSE]
  }
  m <- as.matrix(m)
  suppressWarnings(storage.mode(m) <- "double")
  m[is.na(m)] <- 0
  m
}

# ---- 读入：分类表 (feature_id + 界门纲目科属种 或 单列 QIIME 分号串) ---------
.MICROBE_RANKS <- c("Kingdom", "Phylum", "Class", "Order", "Family", "Genus", "Species")
.MICROBE_RANK_ALIAS <- list(
  Kingdom = c("Kingdom", "Domain", "kingdom", "domain", "k"),
  Phylum  = c("Phylum", "phylum", "p"),
  Class   = c("Class", "class", "c"),
  Order   = c("Order", "order", "o"),
  Family  = c("Family", "family", "f"),
  Genus   = c("Genus", "genus", "g"),
  Species = c("Species", "species", "s")
)

microbe_read_taxonomy <- function(path) {
  tx <- read.csv(path, header = TRUE, check.names = FALSE, stringsAsFactors = FALSE)
  fid <- c("feature_id", "OTU_ID", "OTUID", "#OTU ID", "ASV_ID", "ASV", "OTU", "ID", "taxon")
  hit <- intersect(fid, names(tx))
  if (length(hit) == 0) names(tx)[1] <- "feature_id" else if (hit[1] != "feature_id") {
    names(tx)[which(names(tx) == hit[1])] <- "feature_id"
  }
  # 情况一：已含分列的分类等级
  present <- character(0)
  for (r in .MICROBE_RANKS) {
    al <- .MICROBE_RANK_ALIAS[[r]]
    h <- intersect(al, names(tx))
    if (length(h) > 0 && h[1] != r) names(tx)[which(names(tx) == h[1])] <- r
    if (r %in% names(tx)) present <- c(present, r)
  }
  if (length(present) >= 2) {
    out <- tx[, c("feature_id", present), drop = FALSE]
    return(.microbe_clean_tax(out, present))
  }
  # 情况二：单列分号串 (k__..;p__..;c__..;o__..;f__..;g__..;s__..)
  taxcol <- setdiff(names(tx), "feature_id")
  taxcol <- taxcol[which.max(vapply(taxcol, function(cc) mean(grepl(";", tx[[cc]])), 0))]
  parts <- strsplit(as.character(tx[[taxcol]]), "\\s*;\\s*")
  mat <- matrix("", nrow = nrow(tx), ncol = 7,
                dimnames = list(NULL, .MICROBE_RANKS))
  for (i in seq_along(parts)) {
    v <- parts[[i]]
    v <- sub("^[a-zA-Z]__", "", v)          # 去 k__/p__ 前缀
    v <- trimws(v)
    n <- min(length(v), 7)
    if (n > 0) mat[i, seq_len(n)] <- v[seq_len(n)]
  }
  out <- data.frame(feature_id = tx$feature_id, mat, check.names = FALSE, stringsAsFactors = FALSE)
  .microbe_clean_tax(out, .MICROBE_RANKS)
}

.microbe_clean_tax <- function(out, ranks) {
  for (r in ranks) {
    x <- as.character(out[[r]])
    x[is.na(x) | x %in% c("", "NA", "unclassified", "Unclassified", "unidentified", "__")] <- NA
    out[[r]] <- x
  }
  out
}

# ---- 对齐特征表与元数据（取样本交集，保持元数据顺序） ----------------------
microbe_align <- function(feature, meta) {
  fsamp <- setdiff(names(feature), "feature_id")
  common <- intersect(meta$sample_name, fsamp)
  if (length(common) < 2) stop("特征表与元数据的公共样本不足 2 个，请检查样本名是否一致")
  meta2 <- meta[meta$sample_name %in% common, , drop = FALSE]
  list(samples = meta2$sample_name, meta = meta2)
}

# ---- 按分类层级汇总：返回 行=taxa 列=样本 的计数矩阵 -----------------------
microbe_collapse <- function(feature, taxonomy, level, samples) {
  if (!level %in% names(taxonomy)) {
    stop(paste0("分类表不含层级 '", level, "'，可用: ",
                paste(setdiff(names(taxonomy), "feature_id"), collapse = ", ")))
  }
  m <- microbe_feature_matrix(feature, samples)
  key <- taxonomy[[level]][match(rownames(m), taxonomy$feature_id)]
  key[is.na(key) | key == ""] <- "Unclassified"
  agg <- rowsum(m, group = key, reorder = TRUE)
  agg
}

# ---- 相对丰度（按列/样本归一到比例） ---------------------------------------
microbe_relabund <- function(mat) {
  cs <- colSums(mat)
  cs[cs == 0] <- 1
  sweep(mat, 2, cs, "/")
}

# ---- 取 top-N 类群，其余合并为 Others（基于平均相对丰度排序） --------------
microbe_top_taxa <- function(mat, top_n = 10, others_label = "Others") {
  ra <- microbe_relabund(mat)
  ord <- order(rowMeans(ra), decreasing = TRUE)
  mat <- mat[ord, , drop = FALSE]
  if (nrow(mat) <= top_n) return(mat)
  top <- mat[seq_len(top_n), , drop = FALSE]
  others <- colSums(mat[(top_n + 1):nrow(mat), , drop = FALSE])
  out <- rbind(top, others)
  rownames(out)[nrow(out)] <- others_label
  out
}

# ---- 抽平（vegan::rrarefy；depth=NULL 时取最小样本深度） -------------------
microbe_rarefy <- function(mat, depth = NULL, seed = 123) {
  microbe_library(c("vegan"))
  set.seed(seed)
  cm <- t(round(mat))
  d <- if (is.null(depth)) min(rowSums(cm)) else depth
  keep <- rowSums(cm) >= d
  cm <- cm[keep, , drop = FALSE]
  rr <- vegan::rrarefy(cm, sample = d)
  list(mat = t(rr), depth = d, dropped = sum(!keep))
}

# ---- 出版级主题 -------------------------------------------------------------
theme_microbe <- function(base_size = 12) {
  ggplot2::theme_bw(base_size = base_size) +
    ggplot2::theme(
      panel.grid = ggplot2::element_blank(),
      panel.border = ggplot2::element_rect(colour = "black", fill = NA),
      axis.text = ggplot2::element_text(color = "black"),
      axis.title = ggplot2::element_text(color = "black"),
      axis.ticks = ggplot2::element_line(color = "black", linewidth = 0.4),
      legend.key = ggplot2::element_blank(),
      plot.title = ggplot2::element_text(hjust = 0.5, colour = "black")
    )
}

# ---- 配色 -------------------------------------------------------------------
# 分组配色（Okabe-Ito 色盲友好 + 课程红橙蓝）
.MICROBE_PAL_GROUP <- c("#E64B35", "#4DBBD5", "#00A087", "#3C5488", "#F39B7F",
                        "#8491B4", "#91D1C2", "#DC0000", "#7E6148", "#B09C85")
# 类群堆叠柱配色（20 色，末位灰给 Others/Unclassified）
.MICROBE_PAL_TAXA <- c("#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
                       "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf",
                       "#aec7e8", "#ffbb78", "#98df8a", "#ff9896", "#c5b0d5",
                       "#c49c94", "#f7b6d2", "#dbdb8d", "#9edae5", "#393b79")

microbe_palette <- function(n, name = "group") {
  base <- switch(name,
                 taxa = .MICROBE_PAL_TAXA,
                 group = .MICROBE_PAL_GROUP,
                 .MICROBE_PAL_GROUP)
  if (n <= length(base)) base[seq_len(n)] else grDevices::colorRampPalette(base)(n)
}

# 给分组返回命名颜色向量
microbe_group_colors <- function(groups, name = "group") {
  lv <- levels(as.factor(groups))
  cols <- microbe_palette(length(lv), name)
  stats::setNames(cols, lv)
}

# 给类群返回命名颜色（Others/Unclassified 固定灰）
microbe_taxa_colors <- function(taxa) {
  grey_lab <- intersect(c("Others", "Unclassified"), taxa)
  main <- setdiff(taxa, grey_lab)
  cols <- microbe_palette(length(main), "taxa")
  cols <- stats::setNames(cols, main)
  for (g in grey_lab) cols[g] <- "#bdbdbd"
  cols[taxa]
}

# 两两比较列表（供 ggpubr::stat_compare_means comparisons）
microbe_comparisons <- function(groups) {
  lv <- levels(as.factor(groups))
  if (length(lv) < 2) return(list())
  cb <- utils::combn(lv, 2, simplify = FALSE)
  cb
}

# ---- 保存：ggplot 对象 → png+pdf 并回传 ------------------------------------
microbe_save <- function(plot, outdir, base, width = 7, height = 6, dpi = 300,
                         formats = c("png", "pdf")) {
  microbe_ensure_dir(outdir)
  for (fmt in formats) {
    f <- file.path(outdir, paste0(base, ".", fmt))
    ggplot2::ggsave(f, plot = plot, width = width, height = height, dpi = dpi, bg = "white",
                    limitsize = FALSE)
    microbe_emit(f)
  }
  invisible(TRUE)
}

# ---- 保存：base graphics (pheatmap/plot 等) → png+pdf ----------------------
microbe_save_base <- function(outdir, base, draw_fn, width = 7, height = 6, dpi = 300,
                              formats = c("png", "pdf")) {
  microbe_ensure_dir(outdir)
  for (fmt in formats) {
    f <- file.path(outdir, paste0(base, ".", fmt))
    if (fmt == "png") {
      grDevices::png(f, width = width, height = height, units = "in", res = dpi)
    } else {
      grDevices::pdf(f, width = width, height = height)
    }
    draw_fn()
    grDevices::dev.off()
    microbe_emit(f)
  }
  invisible(TRUE)
}

# ---- 写出 CSV 并回传 --------------------------------------------------------
microbe_write_csv <- function(df, outdir, base, row.names = FALSE) {
  microbe_ensure_dir(outdir)
  f <- file.path(outdir, paste0(base, ".csv"))
  write.csv(df, f, row.names = row.names)
  microbe_emit(f)
  invisible(f)
}
