import type { ReactNode } from "react";
import { createContext, useState } from "react";
import type {
	AnnotationContextType,
	Interactions,
	SegmentationCategories,
} from "../types";

type ProviderProps = {
	children: ReactNode;
};

export const AnnotationContext = createContext<AnnotationContextType>({
	annotationType: "",
	annotationColor: "blue",
	segmentationType: ["aorta"],
	segmentationOpacity: 0.5,
	setSegmentationOpacity: () => {},
	setAnnotationColor: () => {},
	setAnnotationType: () => {},
	setSegmentationType: () => {},
});
export const AnnotationProvider = ({ children }: ProviderProps) => {
	const [annotationType, setAnnotationType] = useState<Interactions>("");
	const [annotationColor, setAnnotationColor] = useState<string>("blue");
	const [segmentationOpacity, setSegmentationOpacity] = useState<number>(0.5);
	const [segmentationType, setSegmentationType] = useState<
		SegmentationCategories[]
	>(["aorta"]);

	return (
		<AnnotationContext.Provider
			value={{
				annotationType,
				setAnnotationType,
				annotationColor,
				setAnnotationColor,
				segmentationType,
				setSegmentationType,
				segmentationOpacity,
				setSegmentationOpacity,
			}}
		>
			{children}
		</AnnotationContext.Provider>
	);
};
