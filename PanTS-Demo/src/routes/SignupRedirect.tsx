import { useEffect } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../contexts/authContext";

// /signup used to be a page. Creating an account is the auth popup's signup mode
// now, so this route sends you home and opens it — old links, bookmarks and any
// external references still land on the right thing instead of a 404.
export default function SignupRedirect() {
	const { isAuthenticated, loading, promptAuth } = useAuth();

	useEffect(() => {
		// Nothing to open for someone who is already signed in; the redirect
		// below takes them to the app.
		if (!loading && !isAuthenticated) promptAuth("signup");
	}, [loading, isAuthenticated, promptAuth]);

	// Wait for the session check before choosing a destination, so a signed-in
	// visitor isn't bounced to the landing page for a frame.
	if (loading) return null;
	return <Navigate to={isAuthenticated ? "/upload" : "/"} replace />;
}
