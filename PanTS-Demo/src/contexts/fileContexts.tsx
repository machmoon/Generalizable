import type { ReactNode } from "react";
import { createContext, useState } from "react";
import type { FileContextType, fileData } from "../types";

type ProviderProps = {
	children: ReactNode;
};

export const FileContext = createContext<FileContextType>({
	files: [],
	setFiles: () => {}
});
export const FileProvider = ({ children }: ProviderProps) => {
	const [files, setFiles] = useState<fileData[]>([]);
	return (
		<FileContext.Provider value={{ files, setFiles }}>
			{children}
		</FileContext.Provider>
	);
};
