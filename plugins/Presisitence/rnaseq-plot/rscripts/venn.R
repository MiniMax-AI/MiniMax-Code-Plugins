# venn.R —— 韦恩图（2-5 组）+ 交集成员表
# params: sets(CSV 路径向量) 或 folder(装 CSV 的目录), col(元素列名,默认自动: Element_name/gene_id/首列),
#         names(可选,各集合名), outdir, name("venn"), dpi(300), width(7),height(7)
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("VennDiagram"))
suppressWarnings(try(futile.logger::flog.threshold(futile.logger::ERROR, name = "VennDiagramLogger"),
                     silent = TRUE))

pick_col <- function(df, col) {
  if (!is.null(col) && col %in% names(df)) return(col)
  for (c in c("Element_name", "gene_id", "Gene_symbol")) if (c %in% names(df)) return(c)
  names(df)[1]
}

# 收集集合
if (!is.null(p$folder)) {
  files <- list.files(p$folder, pattern = "\\.csv$", full.names = TRUE)
  set_names <- tools::file_path_sans_ext(basename(files))
} else {
  files <- p$sets
  set_names <- if (!is.null(p$names)) p$names else tools::file_path_sans_ext(basename(files))
}
if (length(files) < 2 || length(files) > 5) stop("韦恩图支持 2-5 个集合")

elem <- list()
for (i in seq_along(files)) {
  df <- read.csv(files[i], header = TRUE, check.names = FALSE, stringsAsFactors = FALSE)
  v <- unique(df[[pick_col(df, p$col)]])
  elem[[set_names[i]]] <- v[!is.na(v) & v != ""]
}

fill <- rgraph_palette(length(elem), rgraph_opt(p, "palette", "course"))
grob <- VennDiagram::venn.diagram(elem, category.names = names(elem), filename = NULL,
                                  fill = fill, col = NA, cat.col = "black", cat.cex = 0.9,
                                  cex = 1.1, margin = 0.08)

rgraph_save_base(p$outdir, rgraph_opt(p, "name", "venn"),
                 function() { grid::grid.newpage(); grid::grid.draw(grob) },
                 width = rgraph_opt(p, "width", 7), height = rgraph_opt(p, "height", 7),
                 dpi = rgraph_opt(p, "dpi", 300))

# 成员表
all_g <- unique(unlist(elem))
tab <- data.frame(Element = all_g)
for (nm in names(elem)) tab[[nm]] <- all_g %in% elem[[nm]]
rgraph_write_csv(tab, p$outdir, "veen_table")
cat("RGRAPH_DONE: venn sets=", length(elem), "elements=", length(all_g), "\n")
