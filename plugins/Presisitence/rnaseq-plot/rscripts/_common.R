# =============================================================================
# _common.R  —  rgraph-mcp 共享 R 库
# 所有出图/分析模板都 source() 本文件，统一：参数读取、包预检、样本表规整、
# 出版级主题、配色、png+pdf 导出、产物回传标记。
#
# 相比原课程脚本的改进：
#   * 不再 setwd() 到硬编码路径 / 不 rm(list=ls())；一切走参数与相对/绝对入参。
#   * 统一 group / group_name 列名混用问题（二者缺一自动补齐）。
#   * 缺包时输出 RGRAPH_MISSING_PACKAGES 标记并以状态码 3 退出，交由上层友好提示。
#   * 产物统一通过 RGRAPH_OUTPUT 标记回传，Python 侧据此收集图片路径。
# =============================================================================

options(stringsAsFactors = FALSE, warn = 1)

# ---- 参数读取 ---------------------------------------------------------------
rgraph_load_params <- function() {
  args <- commandArgs(trailingOnly = TRUE)
  if (length(args) < 1) stop("缺少参数文件路径 (params file)")
  e <- new.env()
  sys.source(args[[1]], envir = e)
  if (!exists("params", envir = e)) stop("参数文件未定义 params 列表")
  get("params", envir = e)
}

rgraph_opt <- function(p, key, default = NULL) {
  v <- p[[key]]
  if (is.null(v)) default else v
}

`%||%` <- function(a, b) if (is.null(a)) b else a

# ---- 包预检 -----------------------------------------------------------------
rgraph_need <- function(pkgs) {
  inst <- rownames(installed.packages())
  miss <- setdiff(pkgs, inst)
  if (length(miss) > 0) {
    cat("RGRAPH_MISSING_PACKAGES:", paste(miss, collapse = ","), "\n")
    quit(save = "no", status = 3)
  }
  invisible(TRUE)
}

rgraph_library <- function(pkgs) {
  rgraph_need(pkgs)
  for (p in pkgs) suppressMessages(suppressWarnings(library(p, character.only = TRUE)))
  invisible(TRUE)
}

# ---- 产物回传 / 目录 --------------------------------------------------------
rgraph_emit <- function(path) {
  cat("RGRAPH_OUTPUT:", normalizePath(path, winslash = "/", mustWork = FALSE), "\n")
}

rgraph_ensure_dir <- function(path) {
  if (!dir.exists(path)) dir.create(path, recursive = TRUE, showWarnings = FALSE)
  invisible(path)
}

# ---- 读入：样本分组表（规整 group / group_name / TvsC） --------------------
rgraph_read_sample_group <- function(path) {
  sg <- read.csv(path, header = TRUE, check.names = FALSE, stringsAsFactors = FALSE)
  if (!"sample_name" %in% names(sg)) stop("sample_group 缺少 sample_name 列")
  sg <- sg[!is.na(sg$sample_name) & sg$sample_name != "", , drop = FALSE]
  has_g <- "group" %in% names(sg)
  has_gn <- "group_name" %in% names(sg)
  if (has_g && !has_gn) sg$group_name <- sg$group
  if (has_gn && !has_g) sg$group <- sg$group_name
  if (!has_g && !has_gn) { sg$group <- sg$sample_name; sg$group_name <- sg$sample_name }
  if (!"TvsC" %in% names(sg)) sg$TvsC <- NA_character_
  sg
}

# ---- 读入：表达矩阵 (gene_id + 各样本列) -----------------------------------
rgraph_read_matrix <- function(path) {
  df <- read.csv(path, header = TRUE, check.names = FALSE, stringsAsFactors = FALSE)
  if (!"gene_id" %in% names(df)) {
    names(df)[1] <- "gene_id"  # 容错：首列视作 gene_id
  }
  df
}

# 校验 sample_group 中样本是否都在矩阵列里
rgraph_check_samples <- function(mat, sample_list) {
  miss <- setdiff(sample_list, colnames(mat))
  if (length(miss) > 0) {
    stop(paste0("以下样本不在表达矩阵中: ", paste(miss, collapse = ", ")))
  }
  invisible(TRUE)
}

# ---- 出版级主题 -------------------------------------------------------------
theme_rgraph <- function(base_size = 12) {
  ggplot2::theme_minimal(base_size = base_size) +
    ggplot2::theme(
      panel.grid = ggplot2::element_blank(),
      panel.border = ggplot2::element_rect(colour = "black", fill = NA),
      axis.text = ggplot2::element_text(color = "black"),
      axis.title = ggplot2::element_text(color = "black"),
      axis.ticks = ggplot2::element_line(color = "black", linewidth = 0.4),
      axis.ticks.length = ggplot2::unit(0.1, "cm"),
      legend.position = "right",
      plot.title = ggplot2::element_text(hjust = 0.5, colour = "black")
    )
}

# ---- 配色 -------------------------------------------------------------------
.RGRAPH_PAL_COURSE <- c("#f03e3e", "#FF9933", "#CCCCFF", "#00CCCC", "#00CC66",
                        "#009999", "#d4d445", "#0066CC", "#FFCCFF")
# Okabe-Ito 色盲友好
.RGRAPH_PAL_CB <- c("#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2",
                    "#D55E00", "#CC79A7", "#999999", "#000000")

rgraph_palette <- function(n, name = "course") {
  base <- switch(name,
                 colorblind = .RGRAPH_PAL_CB,
                 course = .RGRAPH_PAL_COURSE,
                 .RGRAPH_PAL_COURSE)
  if (n <= length(base)) base[seq_len(n)] else grDevices::colorRampPalette(base)(n)
}

# 火山图/上下调三色（默认色盲友好红-蓝，可切换课程红-绿）
rgraph_updown_colors <- function(scheme = "rb") {
  if (identical(scheme, "rg")) {
    c(Up = "red", Down = "green", No = "grey80")
  } else {
    c(Up = "#d73027", Down = "#4575b4", No = "grey80")
  }
}

# ---- 保存：ggplot 对象 → png+pdf 并回传 ------------------------------------
rgraph_save <- function(plot, outdir, base, width = 8, height = 6, dpi = 300,
                        formats = c("png", "pdf")) {
  rgraph_ensure_dir(outdir)
  for (fmt in formats) {
    f <- file.path(outdir, paste0(base, ".", fmt))
    ggplot2::ggsave(f, plot = plot, width = width, height = height, dpi = dpi, bg = "white")
    rgraph_emit(f)
  }
  invisible(TRUE)
}

# ---- 保存：base graphics (pheatmap/plotGOgraph/pathview) → png+pdf --------
rgraph_save_base <- function(outdir, base, draw_fn, width = 8, height = 6, dpi = 300,
                             formats = c("png", "pdf")) {
  rgraph_ensure_dir(outdir)
  for (fmt in formats) {
    f <- file.path(outdir, paste0(base, ".", fmt))
    if (fmt == "png") {
      grDevices::png(f, width = width, height = height, units = "in", res = dpi)
    } else {
      grDevices::pdf(f, width = width, height = height)
    }
    draw_fn()
    grDevices::dev.off()
    rgraph_emit(f)
  }
  invisible(TRUE)
}

# ---- 写出 CSV 并回传 --------------------------------------------------------
rgraph_write_csv <- function(df, outdir, base, row.names = FALSE) {
  rgraph_ensure_dir(outdir)
  f <- file.path(outdir, paste0(base, ".csv"))
  write.csv(df, f, row.names = row.names)
  rgraph_emit(f)
  invisible(f)
}
