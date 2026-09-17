# quadrant.R —— 九象限图 / 二象限图（两组差异比较的 log2FC 散点）
# params: x(比较1的DEG CSV,列 gene_id,log2FoldChange,pvalue), y(比较2的DEG CSV),
#         x_name, y_name, mode("nine"|"four"), pcut(0.05), log2fc(1), outdir, dpi,width,height, name
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("dplyr", "ggplot2"))

mode <- rgraph_opt(p, "mode", "nine")
pcut <- rgraph_opt(p, "pcut", 0.05)
log2fc <- rgraph_opt(p, "log2fc", 1)
xn <- rgraph_opt(p, "x_name", "compare1")
yn <- rgraph_opt(p, "y_name", "compare2")

read_cmp <- function(path, nm) {
  d <- read.csv(path, check.names = FALSE)
  d <- d[!is.na(d$pvalue) & d$pvalue < pcut, ]
  if (mode == "four") d <- d[abs(d$log2FoldChange) > log2fc, ]
  d <- d[, c("gene_id", "log2FoldChange")]
  names(d)[2] <- nm
  d
}
dx <- read_cmp(p$x, xn); dy <- read_cmp(p$y, yn)
m <- merge(dx, dy, by = "gene_id")
X <- m[[xn]]; Y <- m[[yn]]

if (mode == "four") {
  m <- m[(X > 0 & Y > 0) | (X < 0 & Y < 0), ]
  X <- m[[xn]]; Y <- m[[yn]]
  m$cls <- ifelse(abs(X) >= abs(Y), "High", "Low")
  cnt <- table(m$cls)
  cmap <- c(High = "#FF3333", Low = "#00CCCC")
  labs2 <- c(High = sprintf("High (%d)", cnt["High"]), Low = sprintf("Low (%d)", cnt["Low"]))
  brk <- c("High", "Low")
} else {
  m$cls <- ifelse(X >= log2fc & Y >= log2fc, "Q1",
           ifelse(abs(X) < log2fc & Y >= log2fc, "Q2",
           ifelse(X <= -log2fc & Y >= log2fc, "Q3",
           ifelse(X >= log2fc & abs(Y) < log2fc, "Q4",
           ifelse(abs(X) < log2fc & abs(Y) < log2fc, "Q5",
           ifelse(X <= -log2fc & abs(Y) < log2fc, "Q6",
           ifelse(X >= log2fc & Y <= -log2fc, "Q7",
           ifelse(abs(X) < log2fc & Y <= -log2fc, "Q8",
           ifelse(X <= -log2fc & Y <= -log2fc, "Q9", "No")))))))))
  cnt <- table(factor(m$cls, levels = paste0("Q", 1:9)))
  cmap <- setNames(c("#ede746", "#FF9933", "#FF3333", "#FFCCFF", "grey80",
                     "#FF66FF", "#CCFFFF", "#00FF99", "#00CCCC"), paste0("Q", 1:9))
  labs2 <- setNames(sprintf("quadrant.%d (%d)", 1:9, cnt), paste0("Q", 1:9))
  brk <- paste0("Q", 1:9)
}
rgraph_write_csv(m, p$outdir, if (mode == "four") "Four_quadrant_table" else "Nine_quadrant_table")

pl <- ggplot2::ggplot(m, ggplot2::aes(x = .data[[xn]], y = .data[[yn]], color = cls)) +
  ggplot2::geom_point(alpha = 0.8, size = 0.7) +
  ggplot2::scale_color_manual(values = cmap, breaks = brk, labels = labs2) +
  ggplot2::geom_hline(yintercept = c(-log2fc, log2fc), linetype = "dashed", color = "grey") +
  ggplot2::geom_vline(xintercept = c(-log2fc, log2fc), linetype = "dashed", color = "grey") +
  ggplot2::labs(x = sprintf("log2FoldChange(%s)", xn), y = sprintf("log2FoldChange(%s)", yn),
                color = sprintf("pvalue<%s", pcut)) +
  theme_rgraph() +
  ggplot2::guides(color = ggplot2::guide_legend(override.aes = list(size = 3)))

rgraph_save(pl, p$outdir, rgraph_opt(p, "name", if (mode == "four") "Four_quadrant" else "Nine_quadrant"),
            width = rgraph_opt(p, "width", 7.3), height = rgraph_opt(p, "height", 6),
            dpi = rgraph_opt(p, "dpi", 300))
cat("RGRAPH_DONE: quadrant", mode, "genes=", nrow(m), "\n")
