# multilevel_scatter.R —— 多级分组基因表达散点图（逐基因；主分组 x，次分组着色）
# 输入: expr(gene_expression.csv: gene_id+各样本), sample_group(多级分组表)
# params: expr, sample_group, gene_list(CSV) 或 genes(向量), outdir,
#         sample_col(默认自动 sample_name/sample_name1), x_col(默认自动 group_name/group_name1),
#         color_col(默认 group_name2, 无则同 x_col), dpi(300), width(8),height(8)
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("dplyr", "tidyr", "ggplot2"))

sg <- read.csv(p$sample_group, header = TRUE, check.names = FALSE, stringsAsFactors = FALSE)
pick <- function(cands, override) {
  if (!is.null(override) && override %in% names(sg)) return(override)
  hit <- intersect(cands, names(sg)); if (length(hit)) hit[1] else stop(paste0("缺少列: ", cands[1]))
}
sample_col <- pick(c("sample_name", "sample_name1"), rgraph_opt(p, "sample_col", NULL))
x_col <- pick(c("group_name", "group_name1", "group"), rgraph_opt(p, "x_col", NULL))
color_col <- rgraph_opt(p, "color_col", if ("group_name2" %in% names(sg)) "group_name2" else x_col)

expr <- rgraph_read_matrix(p$expr)
genes <- if (!is.null(p$genes)) p$genes else read.csv(p$gene_list, check.names = FALSE)$gene_id
cols <- rgraph_palette(length(unique(sg[[color_col]])), rgraph_opt(p, "palette", "course"))

n_ok <- 0
for (g in genes) {
  row <- expr[expr$gene_id == g, , drop = FALSE]
  if (nrow(row) == 0) next
  vals <- as.numeric(row[1, intersect(sg[[sample_col]], names(expr))])
  df <- data.frame(sample = intersect(sg[[sample_col]], names(expr)), expression = vals)
  df <- merge(df, sg, by.x = "sample", by.y = sample_col)
  df$.x <- factor(df[[x_col]], levels = unique(sg[[x_col]]))
  df$.col <- factor(df[[color_col]], levels = unique(sg[[color_col]]))
  pl <- ggplot2::ggplot(df, ggplot2::aes(x = .x, y = expression, color = .col)) +
    ggplot2::geom_point(position = ggplot2::position_dodge(0.6), size = 4, alpha = 0.7) +
    ggplot2::scale_color_manual(values = cols, name = color_col) +
    ggplot2::labs(title = g, x = NULL, y = "Expression") + theme_rgraph()
  rgraph_save(pl, p$outdir, paste0(gsub("[^A-Za-z0-9_.-]", "_", g), "_expression"),
              width = rgraph_opt(p, "width", 8), height = rgraph_opt(p, "height", 8),
              dpi = rgraph_opt(p, "dpi", 300))
  n_ok <- n_ok + 1
}
if (n_ok == 0) stop("gene_list 中没有基因命中表达矩阵")
cat("RGRAPH_DONE: multilevel_scatter genes=", n_ok, "\n")
