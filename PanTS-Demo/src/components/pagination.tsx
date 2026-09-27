import { NavLink } from "react-router-dom";

type PaginationProps = {
  currentPage: number;
  totalPages: number;
  basePath: string;
  windowSize?: number;
};

export default function Pagination({
  currentPage,
  totalPages,
  basePath,
  windowSize = 5,
}: PaginationProps) {
  const half = Math.floor(windowSize / 2);
  let start = Math.max(1, currentPage - half);
  let end = Math.min(totalPages, currentPage + half);

  if (currentPage <= half) end = Math.min(totalPages, windowSize);
  if (currentPage + half > totalPages) start = Math.max(1, totalPages - windowSize + 1);

  const pages = [];
  for (let i = start; i <= end; i++) pages.push(i);

  return (
    <div className="mt-4 flex gap-2">
      <NavLink
        to={`/${basePath}/${Math.max(1, currentPage - 1)}`}
        style={{ pointerEvents: currentPage === 1 ? "none" : "auto", opacity: currentPage === 1 ? 0.5 : 1 }}
      >
        Prev
      </NavLink>

      {pages.map((p) => (
        <NavLink
          key={p}
          to={`/${basePath}/${p}`}
          style={{ fontWeight: currentPage === p ? "bold" : "normal" }}
        >
          {p}
        </NavLink>
      ))}

      <NavLink
        to={`/${basePath}/${Math.min(totalPages, currentPage + 1)}`}
        style={{ pointerEvents: currentPage === totalPages ? "none" : "auto", opacity: currentPage === totalPages ? 0.5 : 1 }}
      >
        Next
      </NavLink>
    </div>
  );
}
