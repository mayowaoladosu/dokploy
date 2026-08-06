import type { GetServerSideProps } from "next";

const ManagedNotFoundPage = () => null;

export default ManagedNotFoundPage;

export const getServerSideProps: GetServerSideProps = async () => ({
	notFound: true,
});
